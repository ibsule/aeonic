import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { and, eq, sql } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents, derivatives, storageObjects } from '../db/schema.js'
import {
  DerivativeLeaseLostError,
  type DerivativeRecord,
  SqliteDerivativeRepository,
} from '../derivatives/repository.js'
import { JobExecutionError, type JobHandler } from '../jobs/runner.js'
import {
  createStorageObjectKey,
  StorageError,
  type StorageObjectKey,
} from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import {
  convertOfficeToPdf,
  createPdfThumbnail,
  extractPdfText,
  inspectPdf,
} from './document-processor.js'
import { inspectImage } from './image-inspector.js'
import { MediaCommandError } from './subprocess.js'
import { createVideoDerivative, createVideoPoster, inspectVideo } from './video-processor.js'

interface DerivativePayload {
  derivativeId: string
  assetId: string
  assetVersionId: string
  preset?: 'mp4-720p' | 'webm-720p'
  atMs?: number
  width?: number
  startMs?: number
  durationMs?: number
  page?: number
  maxDimension?: number
}

interface GeneratedOutput {
  content: Buffer
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

type DerivativeHandlerConfig = Pick<
  AppConfig,
  | 'uploadMaxBytes'
  | 'imageMaxOutputBytes'
  | 'imageMaxInputPixels'
  | 'imageMaxFrames'
  | 'videoMaxDurationSeconds'
  | 'videoMaxWidth'
  | 'videoMaxHeight'
  | 'documentMaxPages'
  | 'documentMaxPagePoints'
  | 'documentMaxTextBytes'
  | 'projectStorageQuotaBytes'
  | 'workerJobTimeoutMs'
>

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : undefined
}

function readPayload(value: Record<string, unknown>): DerivativePayload {
  const derivativeId = value.derivativeId
  const assetId = value.assetId
  const assetVersionId = value.assetVersionId
  if (
    typeof derivativeId !== 'string' ||
    !isUuid(derivativeId) ||
    typeof assetId !== 'string' ||
    !isUuid(assetId) ||
    typeof assetVersionId !== 'string' ||
    !isUuid(assetVersionId)
  ) {
    throw new JobExecutionError(
      'invalid_job_payload',
      'The derivative job payload is invalid.',
      false,
    )
  }
  return {
    derivativeId,
    assetId,
    assetVersionId,
    ...(value.preset === 'mp4-720p' || value.preset === 'webm-720p'
      ? { preset: value.preset }
      : {}),
    ...(safeInteger(value.atMs, 0, 86_400_000) !== undefined ? { atMs: value.atMs as number } : {}),
    ...(safeInteger(value.width, 1, 1_920) !== undefined ? { width: value.width as number } : {}),
    ...(safeInteger(value.startMs, 0, 86_400_000) !== undefined
      ? { startMs: value.startMs as number }
      : {}),
    ...(safeInteger(value.durationMs, 1, 60_000) !== undefined
      ? { durationMs: value.durationMs as number }
      : {}),
    ...(safeInteger(value.page, 1, 10_000) !== undefined ? { page: value.page as number } : {}),
    ...(safeInteger(value.maxDimension, 1, 4_096) !== undefined
      ? { maxDimension: value.maxDimension as number }
      : {}),
  }
}

function failure(error: unknown): JobExecutionError {
  if (error instanceof JobExecutionError) return error
  if (error instanceof StorageError) {
    return new JobExecutionError(
      `storage_${error.code}`,
      'Derivative storage failed.',
      error.retryable,
      { cause: error },
    )
  }
  if (error instanceof MediaCommandError) {
    return new JobExecutionError(
      error.code,
      'The media processor could not create the derivative.',
      error.code === 'command_timeout' || error.code === 'command_aborted',
      { cause: error },
    )
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return new JobExecutionError('invalid_derivative_input', error.message, false, { cause: error })
  }
  return new JobExecutionError(
    'derivative_processing_failed',
    'Derivative processing failed.',
    true,
    {
      cause: error,
    },
  )
}

export class MediaDerivativeHandler {
  readonly #repository: SqliteDerivativeRepository

  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
    private readonly config: DerivativeHandlerConfig,
  ) {
    this.#repository = new SqliteDerivativeRepository(database)
  }

  readonly handle: JobHandler = async (job, context) => {
    const payload = readPayload(job.payload)
    const source = this.lookup(job.organizationId, job.projectId, payload)
    const owner = `job:${job.id}`
    const startedAt = new Date()
    const acquired = this.#repository.acquire(
      {
        organizationId: job.organizationId,
        projectId: job.projectId,
        assetVersionId: payload.assetVersionId,
        kind: source.derivative.kind,
        cacheKey: source.derivative.cacheKey,
        canonicalSpec: source.derivative.canonicalSpec,
        outputFormat: source.derivative.outputFormat,
        processorFingerprint: source.derivative.processorFingerprint,
      },
      owner,
      startedAt,
      new Date(startedAt.getTime() + this.config.workerJobTimeoutMs + 5_000),
    )
    if (!acquired.acquired) {
      if (acquired.derivative.state === 'ready') return
      throw new JobExecutionError(
        'derivative_busy',
        'Another worker is processing this derivative.',
        true,
      )
    }

    const scope = { organizationId: job.organizationId, projectId: job.projectId }
    const storageObjectId = uuidv7()
    const storageKey = createStorageObjectKey(scope, 'derivative', storageObjectId)
    this.database.db
      .insert(storageObjects)
      .values({
        id: storageObjectId,
        ...scope,
        backend: this.storage.backend,
        namespace: 'derivative',
        objectKey: storageKey,
        state: 'staging',
        createdAt: startedAt,
        updatedAt: startedAt,
      })
      .run()

    try {
      context.reportProgress(10)
      const original = await this.storage.port.open(scope, source.storageKey, {
        signal: context.signal,
      })
      const output = await this.generate(
        source.derivative,
        payload,
        source.mimeType,
        original,
        context.signal,
      )
      this.assertQuota(scope, output.content.byteLength)
      context.reportProgress(70)
      const stored = await this.storage.port.put(scope, storageKey, Readable.from(output.content), {
        maxBytes: this.config.imageMaxOutputBytes,
        expectedBytes: output.content.byteLength,
        expectedSha256: createHash('sha256').update(output.content).digest('hex'),
        signal: context.signal,
      })
      const completedAt = new Date()
      this.database.db
        .update(storageObjects)
        .set({
          state: 'available',
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          finalizedAt: completedAt,
          updatedAt: completedAt,
        })
        .where(eq(storageObjects.id, storageObjectId))
        .run()
      this.#repository.complete(payload.derivativeId, owner, completedAt, {
        storageObjectId,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        mimeType: output.mimeType,
        ...(output.width === undefined ? {} : { width: output.width }),
        ...(output.height === undefined ? {} : { height: output.height }),
        ...(output.durationMs === undefined ? {} : { durationMs: output.durationMs }),
      })
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          ...scope,
          actorType: 'system',
          actorId: null,
          action: 'derivative.completed',
          targetType: 'derivative',
          targetId: payload.derivativeId,
          requestId: `job:${job.id}`,
          summary: { kind: source.derivative.kind, sizeBytes: stored.sizeBytes },
          createdAt: completedAt,
        })
        .run()
      context.reportProgress(95)
    } catch (error) {
      const processed = failure(error)
      await this.discard(scope, storageObjectId, storageKey, processed.code)
      try {
        this.#repository.fail(payload.derivativeId, owner, new Date(), processed.code)
      } catch (leaseError) {
        if (!(leaseError instanceof DerivativeLeaseLostError)) throw leaseError
      }
      throw processed
    }
  }

  private lookup(organizationId: string, projectId: string, payload: DerivativePayload) {
    const row = this.database.db
      .select({
        derivative: derivatives,
        assetId: assets.id,
        mimeType: assetVersions.mimeType,
        sourceState: assetVersions.state,
        storageState: storageObjects.state,
        storageKey: storageObjects.objectKey,
      })
      .from(derivatives)
      .innerJoin(assetVersions, eq(assetVersions.id, derivatives.assetVersionId))
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .innerJoin(storageObjects, eq(storageObjects.id, assetVersions.storageObjectId))
      .where(
        and(
          eq(derivatives.id, payload.derivativeId),
          eq(derivatives.organizationId, organizationId),
          eq(derivatives.projectId, projectId),
          eq(assetVersions.id, payload.assetVersionId),
          eq(assets.id, payload.assetId),
        ),
      )
      .get()
    if (
      !row?.mimeType ||
      row.derivative.kind === 'image' ||
      row.sourceState !== 'ready' ||
      row.storageState !== 'available'
    ) {
      throw new JobExecutionError(
        'derivative_target_missing',
        'The derivative source is unavailable.',
        false,
      )
    }
    return {
      derivative: row.derivative,
      mimeType: row.mimeType,
      storageKey: row.storageKey as StorageObjectKey,
    }
  }

  private async generate(
    derivative: DerivativeRecord,
    payload: DerivativePayload,
    mimeType: string,
    source: Readable,
    signal: AbortSignal,
  ): Promise<GeneratedOutput> {
    const videoLimits = {
      maxInputBytes: this.config.uploadMaxBytes,
      maxOutputBytes: this.config.imageMaxOutputBytes,
      maxDurationSeconds: this.config.videoMaxDurationSeconds,
      maxWidth: this.config.videoMaxWidth,
      maxHeight: this.config.videoMaxHeight,
      timeoutMs: this.config.workerJobTimeoutMs,
    }
    const documentLimits = {
      maxInputBytes: this.config.uploadMaxBytes,
      maxOutputBytes: this.config.imageMaxOutputBytes,
      maxPages: this.config.documentMaxPages,
      maxPagePoints: this.config.documentMaxPagePoints,
      maxTextBytes: this.config.documentMaxTextBytes,
      timeoutMs: this.config.workerJobTimeoutMs,
    }
    if (derivative.kind === 'video_poster' && payload.atMs !== undefined && payload.width) {
      const content = await createVideoPoster(source, mimeType, videoLimits, {
        atSeconds: payload.atMs / 1_000,
        width: payload.width,
        signal,
      })
      const metadata = await inspectImage(
        Readable.from(content),
        'image/jpeg',
        { maxInputPixels: this.config.imageMaxInputPixels, maxFrames: this.config.imageMaxFrames },
        signal,
      )
      return { content, mimeType: 'image/jpeg', width: metadata.width, height: metadata.height }
    }
    if (
      derivative.kind === 'video_transcode' &&
      payload.preset &&
      payload.startMs !== undefined &&
      payload.durationMs
    ) {
      const generated = await createVideoDerivative(source, mimeType, payload.preset, videoLimits, {
        atSeconds: payload.startMs / 1_000,
        clipSeconds: payload.durationMs / 1_000,
        signal,
      })
      const metadata = await inspectVideo(
        Readable.from(generated.content),
        generated.mimeType,
        videoLimits,
        signal,
      )
      return {
        content: generated.content,
        mimeType: generated.mimeType,
        width: metadata.width,
        height: metadata.height,
        durationMs: Math.round(metadata.durationSeconds * 1_000),
      }
    }
    if (derivative.kind === 'pdf_thumbnail' && payload.page && payload.maxDimension) {
      const content = await createPdfThumbnail(
        source,
        payload.page,
        payload.maxDimension,
        documentLimits,
        signal,
      )
      const metadata = await inspectImage(
        Readable.from(content),
        'image/png',
        { maxInputPixels: this.config.imageMaxInputPixels, maxFrames: this.config.imageMaxFrames },
        signal,
      )
      return { content, mimeType: 'image/png', width: metadata.width, height: metadata.height }
    }
    if (derivative.kind === 'pdf_text') {
      const content = Buffer.from(await extractPdfText(source, documentLimits, signal), 'utf8')
      return { content, mimeType: 'text/plain; charset=utf-8' }
    }
    if (derivative.kind === 'office_preview') {
      const content = await convertOfficeToPdf(source, mimeType, documentLimits, signal)
      const metadata = await inspectPdf(Readable.from(content), documentLimits, signal)
      return {
        content,
        mimeType: 'application/pdf',
        width: Math.round(metadata.widthPoints),
        height: Math.round(metadata.heightPoints),
      }
    }
    throw new JobExecutionError('invalid_job_payload', 'Derivative parameters are invalid.', false)
  }

  private assertQuota(scope: { organizationId: string; projectId: string }, outputBytes: number) {
    const used =
      this.database.db
        .select({ value: sql<number>`coalesce(sum(${storageObjects.sizeBytes}), 0)` })
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.organizationId, scope.organizationId),
            eq(storageObjects.projectId, scope.projectId),
            eq(storageObjects.state, 'available'),
          ),
        )
        .get()?.value ?? 0
    if (used + outputBytes > this.config.projectStorageQuotaBytes) {
      throw new JobExecutionError(
        'project_storage_quota_exceeded',
        'The derivative would exceed the project storage quota.',
        false,
      )
    }
  }

  private async discard(
    scope: { organizationId: string; projectId: string },
    storageObjectId: string,
    storageKey: StorageObjectKey,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.storage.port.delete(scope, storageKey)
    } catch {
      // The failed row remains discoverable for storage reconciliation.
    }
    this.database.db
      .update(storageObjects)
      .set({ state: 'failed', errorCode, updatedAt: new Date() })
      .where(eq(storageObjects.id, storageObjectId))
      .run()
  }
}
