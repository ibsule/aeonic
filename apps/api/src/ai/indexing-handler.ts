import { Readable } from 'node:stream'
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { validate as isUuid, v5 as uuidv5, v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import {
  aiAssetExclusions,
  aiIndexes,
  aiIndexRecords,
  aiProjectSettings,
  aiUsageLedger,
  assets,
  assetVersions,
  auditEvents,
  semanticEvaluations,
  storageObjects,
} from '../db/schema.js'
import { JobExecutionError, type JobHandler } from '../jobs/runner.js'
import {
  convertOfficeToPdf,
  createPdfThumbnail,
  extractPdfText,
} from '../media/document-processor.js'
import { createVideoPoster } from '../media/video-processor.js'
import type { StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import type {
  EmbeddingProvider,
  ProviderUsage,
  VectorIndex,
  VectorPoint,
  VisionUnderstandingProvider,
} from './contracts.js'
import { evaluationApproved, retrievalMetrics, SEMANTIC_EVALUATION_VERSION } from './evaluation.js'

interface ReindexPayload {
  readonly indexId: string
  readonly maximumAssets: number
}

interface IndexTarget {
  readonly assetId: string
  readonly assetVersionId: string
  readonly name: string
  readonly folder: string
  readonly mediaKind: 'image' | 'video' | 'document'
  readonly mimeType: string
  readonly durationMs: number | null
  readonly metadata: Record<string, unknown> | null
  readonly objectKey: StorageObjectKey
  readonly sizeBytes: number
}

interface Representation {
  readonly kind: 'image' | 'video_keyframe' | 'document_chunk' | 'document_preview'
  readonly ordinal: number
  readonly text: string
  readonly sourceText: string | null
  readonly caption: string | null
  readonly metadata: Record<string, unknown>
}

function reindexPayload(payload: Record<string, unknown>): ReindexPayload {
  if (
    typeof payload.indexId !== 'string' ||
    !isUuid(payload.indexId) ||
    typeof payload.maximumAssets !== 'number' ||
    !Number.isSafeInteger(payload.maximumAssets) ||
    payload.maximumAssets < 1 ||
    payload.maximumAssets > 10_000
  ) {
    throw new JobExecutionError('invalid_job_payload', 'The AI reindex payload is invalid.', false)
  }
  return { indexId: payload.indexId, maximumAssets: payload.maximumAssets }
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '') {
    throw new JobExecutionError('invalid_job_payload', 'The AI cleanup payload is invalid.', false)
  }
  return value
}

async function readBounded(
  source: Readable,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of source) {
    if (signal.aborted) throw signal.reason
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > maximumBytes) {
      source.destroy()
      throw new JobExecutionError(
        'media_limit_exceeded',
        'The media exceeds the AI input limit.',
        false,
      )
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function chunks(text: string): string[] {
  const normalized = text.replaceAll(/\s+/g, ' ').trim()
  if (!normalized) return []
  const output: string[] = []
  for (let start = 0; start < normalized.length && output.length < 32; start += 5_500) {
    output.push(normalized.slice(start, start + 6_000))
  }
  return output
}

export class AiIndexingHandler {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
    private readonly config: AppConfig,
    private readonly vision: VisionUnderstandingProvider,
    private readonly embeddings: EmbeddingProvider,
    private readonly vectors: VectorIndex,
  ) {}

  readonly reindex: JobHandler = async (job, context) => {
    try {
      await this.runReindex(job, context)
    } catch (error) {
      try {
        const payload = reindexPayload(job.payload)
        if (
          (error instanceof JobExecutionError && !error.retryable) ||
          job.attempts >= job.maxAttempts
        ) {
          this.failIndex(
            payload.indexId,
            error instanceof JobExecutionError ? error.code : 'processing_failed',
          )
        }
      } catch {
        // Invalid payloads have no trustworthy index identifier to update.
      }
      throw error
    }
  }

  private readonly runReindex: JobHandler = async (job, context) => {
    const payload = reindexPayload(job.payload)
    const scope = { organizationId: job.organizationId, projectId: job.projectId }
    const index = this.database.db
      .select()
      .from(aiIndexes)
      .where(
        and(
          eq(aiIndexes.id, payload.indexId),
          eq(aiIndexes.organizationId, scope.organizationId),
          eq(aiIndexes.projectId, scope.projectId),
        ),
      )
      .get()
    const settings = this.database.db
      .select()
      .from(aiProjectSettings)
      .where(
        and(
          eq(aiProjectSettings.organizationId, scope.organizationId),
          eq(aiProjectSettings.projectId, scope.projectId),
        ),
      )
      .get()
    if (index?.state !== 'building') return
    if (!settings?.enabled) {
      this.failIndex(index.id, 'semantic_search_disabled')
      throw new JobExecutionError(
        'semantic_search_disabled',
        'Semantic search was disabled before indexing began.',
        false,
      )
    }

    await this.vectors.ensureCollection(index.collectionName, index.dimensions, context.signal)
    const targets = this.targets(scope, settings.allowPrivateAssets, payload.maximumAssets)
    let completed = 0
    for (let offset = 0; offset < targets.length; offset += settings.concurrency) {
      const batch = targets.slice(offset, offset + settings.concurrency)
      await Promise.all(
        batch.map(async (target) => {
          if (context.signal.aborted) throw context.signal.reason
          await this.indexTarget(index, target, settings.monthlyBudgetMicroUsd, context.signal)
          completed += 1
          context.reportProgress(Math.min(85, Math.round((completed / targets.length) * 85)))
        }),
      )
    }
    this.database.db
      .update(aiIndexes)
      .set({ state: 'evaluating', indexedAssets: completed, errorCode: null })
      .where(and(eq(aiIndexes.id, index.id), eq(aiIndexes.state, 'building')))
      .run()
    context.reportProgress(90)
    await this.evaluateAndActivate(index.id, context.signal)
    context.reportProgress(100)
  }

  readonly deleteAsset: JobHandler = async (job, context) => {
    const collectionName = stringPayload(job.payload, 'collectionName')
    const assetId = stringPayload(job.payload, 'assetId')
    if (!isUuid(assetId)) {
      throw new JobExecutionError(
        'invalid_job_payload',
        'The AI cleanup asset ID is invalid.',
        false,
      )
    }
    await this.vectors.deleteAsset(
      collectionName,
      { organizationId: job.organizationId, projectId: job.projectId },
      assetId,
      context.signal,
    )
  }

  readonly deleteIndex: JobHandler = async (job, context) => {
    await this.vectors.deleteCollection(
      stringPayload(job.payload, 'collectionName'),
      context.signal,
    )
  }

  private targets(
    scope: { organizationId: string; projectId: string },
    allowPrivateAssets: boolean,
    limit: number,
  ): IndexTarget[] {
    return this.database.db
      .select({
        assetId: assets.id,
        assetVersionId: assetVersions.id,
        name: assets.name,
        folder: assets.folder,
        mediaKind: assets.mediaKind,
        mimeType: assetVersions.mimeType,
        durationMs: assetVersions.durationMs,
        metadata: assetVersions.metadata,
        objectKey: storageObjects.objectKey,
        sizeBytes: storageObjects.sizeBytes,
      })
      .from(assets)
      .innerJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, assets.currentVersion)),
      )
      .innerJoin(storageObjects, eq(storageObjects.id, assetVersions.storageObjectId))
      .leftJoin(
        aiAssetExclusions,
        and(
          eq(aiAssetExclusions.organizationId, assets.organizationId),
          eq(aiAssetExclusions.projectId, assets.projectId),
          eq(aiAssetExclusions.assetId, assets.id),
        ),
      )
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          eq(assets.state, 'ready'),
          eq(assetVersions.state, 'ready'),
          eq(storageObjects.state, 'available'),
          isNull(assets.deletedAt),
          isNull(aiAssetExclusions.assetId),
          ...(allowPrivateAssets ? [] : [ne(assets.visibility, 'private')]),
        ),
      )
      .limit(limit)
      .all()
      .flatMap((row): IndexTarget[] =>
        row.mimeType && row.sizeBytes !== null
          ? [
              {
                ...row,
                mimeType: row.mimeType,
                objectKey: row.objectKey as StorageObjectKey,
                sizeBytes: row.sizeBytes,
              },
            ]
          : [],
      )
  }

  private async indexTarget(
    index: typeof aiIndexes.$inferSelect,
    target: IndexTarget,
    budget: number,
    signal: AbortSignal,
  ): Promise<void> {
    const scope = { organizationId: index.organizationId, projectId: index.projectId }
    const source = await this.storage.port.open(scope, target.objectKey, { signal })
    const content = await readBounded(
      source,
      Math.min(this.config.uploadMaxBytes, target.sizeBytes),
      signal,
    )
    const representations = await this.representations(index, target, content, budget, signal)
    const points: VectorPoint[] = []
    const records: Array<typeof aiIndexRecords.$inferInsert> = []
    for (const representation of representations) {
      this.assertBudget(scope, budget)
      const embedded = await this.embeddings.embedText({ texts: [representation.text], signal })
      this.recordUsage(scope, index.id, this.embeddings.model, 'embedding', embedded.usage)
      const pointId = uuidv5(
        `${target.assetVersionId}:${representation.kind}:${representation.ordinal}`,
        index.id,
      )
      points.push({
        id: pointId,
        vector: embedded.vectors[0] ?? [],
        payload: {
          organization_id: scope.organizationId,
          project_id: scope.projectId,
          asset_id: target.assetId,
          asset_version_id: target.assetVersionId,
          content_kind: representation.kind,
          chunk_ordinal: representation.ordinal,
          provider: this.embeddings.provider,
          embedding_model: this.embeddings.model,
          embedding_dimensions: this.embeddings.dimensions,
          pipeline_version: index.pipelineVersion,
          prompt_version: index.promptVersion,
          generated_by: 'ai',
        },
      })
      records.push({
        id: uuidv7(),
        ...scope,
        indexId: index.id,
        assetId: target.assetId,
        assetVersionId: target.assetVersionId,
        pointId,
        contentKind: representation.kind,
        chunkOrdinal: representation.ordinal,
        sourceText: representation.sourceText,
        caption: representation.caption,
        metadata: {
          ...representation.metadata,
          generatedBy: representation.caption === null ? 'source' : 'ai',
          ...(representation.caption === null
            ? {}
            : { visionProvider: this.vision.provider, visionModel: this.vision.model }),
        },
        provider: this.embeddings.provider,
        model: this.embeddings.model,
        dimensions: this.embeddings.dimensions,
        promptVersion: index.promptVersion,
        createdAt: new Date(),
      })
    }
    if (points.length === 0) return
    await this.vectors.upsert(index.collectionName, points, signal)
    this.database.db.transaction((transaction) => {
      transaction
        .delete(aiIndexRecords)
        .where(
          and(
            eq(aiIndexRecords.indexId, index.id),
            eq(aiIndexRecords.assetVersionId, target.assetVersionId),
          ),
        )
        .run()
      transaction.insert(aiIndexRecords).values(records).run()
    })
  }

  private async representations(
    index: typeof aiIndexes.$inferSelect,
    target: IndexTarget,
    content: Buffer,
    budget: number,
    signal: AbortSignal,
  ): Promise<Representation[]> {
    const prefix = [target.name, target.folder, JSON.stringify(target.metadata ?? {})].join(' ')
    if (target.mediaKind === 'image') {
      const normalized = await sharp(content, { limitInputPixels: this.config.imageMaxInputPixels })
        .rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer()
      const described = await this.describe(index, budget, normalized, 'image/jpeg', signal)
      return [this.visualRepresentation('image', 0, prefix, described)]
    }
    if (target.mediaKind === 'video') {
      const duration = Math.max(0, (target.durationMs ?? 0) / 1_000)
      const sampleTimes = [...new Set([0, duration * 0.5, Math.max(0, duration - 0.25)])]
      const output: Representation[] = []
      for (const [ordinal, atSeconds] of sampleTimes.entries()) {
        const poster = await createVideoPoster(
          Readable.from(content),
          target.mimeType,
          {
            maxInputBytes: this.config.uploadMaxBytes,
            maxOutputBytes: this.config.imageMaxOutputBytes,
            maxDurationSeconds: this.config.videoMaxDurationSeconds,
            maxWidth: this.config.videoMaxWidth,
            maxHeight: this.config.videoMaxHeight,
            timeoutMs: this.config.workerJobTimeoutMs,
          },
          { atSeconds, width: 960, signal },
        )
        const described = await this.describe(index, budget, poster, 'image/jpeg', signal)
        output.push(
          this.visualRepresentation('video_keyframe', ordinal, prefix, described, { atSeconds }),
        )
      }
      return output
    }
    const limits = {
      maxInputBytes: this.config.uploadMaxBytes,
      maxOutputBytes: this.config.imageMaxOutputBytes,
      maxPages: this.config.documentMaxPages,
      maxPagePoints: this.config.documentMaxPagePoints,
      maxTextBytes: this.config.documentMaxTextBytes,
      timeoutMs: this.config.workerJobTimeoutMs,
    }
    const pdf =
      target.mimeType === 'application/pdf'
        ? content
        : await convertOfficeToPdf(Readable.from(content), target.mimeType, limits, signal)
    const extracted = await extractPdfText(Readable.from(pdf), limits, signal)
    const output = chunks(extracted).map(
      (sourceText, ordinal): Representation => ({
        kind: 'document_chunk',
        ordinal,
        text: `${prefix} ${sourceText}`,
        sourceText,
        caption: null,
        metadata: { mimeType: target.mimeType },
      }),
    )
    const preview = await createPdfThumbnail(Readable.from(pdf), 1, 1024, limits, signal)
    const described = await this.describe(index, budget, preview, 'image/png', signal)
    output.push(this.visualRepresentation('document_preview', 0, prefix, described))
    return output
  }

  private async describe(
    index: typeof aiIndexes.$inferSelect,
    budget: number,
    bytes: Buffer,
    mimeType: 'image/jpeg' | 'image/png',
    signal: AbortSignal,
  ) {
    const scope = { organizationId: index.organizationId, projectId: index.projectId }
    this.assertBudget(scope, budget)
    const result = await this.vision.describeImage({
      bytes,
      mimeType,
      promptVersion: index.promptVersion,
      signal,
    })
    this.recordUsage(scope, index.id, this.vision.model, 'caption', result.usage)
    return result
  }

  private visualRepresentation(
    kind: 'image' | 'video_keyframe' | 'document_preview',
    ordinal: number,
    prefix: string,
    result: Awaited<ReturnType<AiIndexingHandler['describe']>>,
    metadata: Record<string, unknown> = {},
  ): Representation {
    const text = [prefix, result.caption, result.tags.join(' '), result.ocrText ?? ''].join(' ')
    return {
      kind,
      ordinal,
      text,
      sourceText: result.ocrText,
      caption: result.caption,
      metadata: { ...metadata, tags: result.tags, safety: result.safety },
    }
  }

  private async evaluateAndActivate(indexId: string, signal: AbortSignal): Promise<void> {
    const index = this.database.db.select().from(aiIndexes).where(eq(aiIndexes.id, indexId)).get()
    if (index?.state !== 'evaluating') return
    const records = this.database.db
      .select({
        assetId: aiIndexRecords.assetId,
        text: aiIndexRecords.caption,
        source: aiIndexRecords.sourceText,
      })
      .from(aiIndexRecords)
      .where(eq(aiIndexRecords.indexId, index.id))
      .limit(25)
      .all()
    const results = []
    let tenantFilterFailures = 0
    for (const record of records) {
      const query = record.text ?? record.source?.slice(0, 500)
      if (!query) continue
      const embedded = await this.embeddings.embedText({ texts: [query], signal })
      this.recordUsage(
        { organizationId: index.organizationId, projectId: index.projectId },
        index.id,
        this.embeddings.model,
        'embedding',
        embedded.usage,
      )
      const hits = await this.vectors.search(
        index.collectionName,
        embedded.vectors[0] ?? [],
        index,
        10,
        signal,
      )
      results.push({
        expectedAssetIds: [record.assetId],
        returnedAssetIds: hits.map((hit) => hit.assetId),
      })
      const foreign = await this.vectors.search(
        index.collectionName,
        embedded.vectors[0] ?? [],
        { organizationId: uuidv7(), projectId: uuidv7() },
        10,
        signal,
      )
      tenantFilterFailures += foreign.length
    }
    const metrics =
      results.length === 0 ? { recallAt10: 1, ndcgAt10: 1 } : retrievalMetrics(results)
    const approved = evaluationApproved(metrics, tenantFilterFailures)
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .insert(semanticEvaluations)
        .values({
          id: uuidv7(),
          organizationId: index.organizationId,
          projectId: index.projectId,
          indexId: index.id,
          evaluationVersion: SEMANTIC_EVALUATION_VERSION,
          queryCount: Math.max(1, results.length),
          recallAt10Millionths: Math.round(metrics.recallAt10 * 1_000_000),
          ndcgAt10Millionths: Math.round(metrics.ndcgAt10 * 1_000_000),
          tenantFilterFailures,
          approved,
          createdAt: now,
        })
        .run()
      if (approved) {
        transaction
          .update(aiIndexes)
          .set({ state: 'retired' })
          .where(
            and(
              eq(aiIndexes.organizationId, index.organizationId),
              eq(aiIndexes.projectId, index.projectId),
              eq(aiIndexes.state, 'active'),
            ),
          )
          .run()
        transaction
          .update(aiIndexes)
          .set({ state: 'active', evaluatedAt: now, activatedAt: now })
          .where(and(eq(aiIndexes.id, index.id), eq(aiIndexes.state, 'evaluating')))
          .run()
      } else {
        transaction
          .update(aiIndexes)
          .set({ state: 'failed', evaluatedAt: now, errorCode: 'evaluation_failed' })
          .where(eq(aiIndexes.id, index.id))
          .run()
      }
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: index.organizationId,
          projectId: index.projectId,
          actorType: 'system',
          actorId: null,
          action: approved ? 'ai.index_activated' : 'ai.index_rejected',
          targetType: 'ai_index',
          targetId: index.id,
          requestId: `evaluation:${index.id}`,
          summary: {
            ...metrics,
            tenantFilterFailures,
            evaluationVersion: SEMANTIC_EVALUATION_VERSION,
          },
          createdAt: now,
        })
        .run()
    })
    if (!approved) {
      throw new JobExecutionError(
        'evaluation_failed',
        'The candidate semantic index did not meet its activation thresholds.',
        false,
      )
    }
  }

  private assertBudget(scope: { organizationId: string; projectId: string }, budget: number): void {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const spend =
      this.database.db
        .select({ value: sql<number>`coalesce(sum(${aiUsageLedger.costMicroUsd}), 0)` })
        .from(aiUsageLedger)
        .where(
          and(
            eq(aiUsageLedger.organizationId, scope.organizationId),
            eq(aiUsageLedger.projectId, scope.projectId),
            gte(aiUsageLedger.occurredAt, start),
          ),
        )
        .get()?.value ?? 0
    const isFree =
      this.config.aiInputMicroUsdPerMillionUnits === 0 &&
      this.config.aiOutputMicroUsdPerMillionUnits === 0
    if (!isFree && spend >= budget) {
      throw new JobExecutionError(
        'ai_budget_exhausted',
        'The project monthly AI budget has been exhausted.',
        false,
      )
    }
  }

  private recordUsage(
    scope: { organizationId: string; projectId: string },
    indexId: string,
    model: string,
    operation: 'caption' | 'embedding',
    usage: ProviderUsage,
  ): void {
    const costMicroUsd = Math.ceil(
      (usage.inputUnits * this.config.aiInputMicroUsdPerMillionUnits +
        usage.outputUnits * this.config.aiOutputMicroUsdPerMillionUnits) /
        1_000_000,
    )
    this.database.db
      .insert(aiUsageLedger)
      .values({
        id: uuidv7(),
        ...scope,
        indexId,
        provider: this.config.aiProvider,
        model,
        operation,
        inputUnits: usage.inputUnits,
        outputUnits: usage.outputUnits,
        costMicroUsd,
        occurredAt: new Date(),
      })
      .run()
  }

  private failIndex(indexId: string, errorCode: string): void {
    this.database.db
      .update(aiIndexes)
      .set({ state: 'failed', errorCode })
      .where(eq(aiIndexes.id, indexId))
      .run()
  }
}
