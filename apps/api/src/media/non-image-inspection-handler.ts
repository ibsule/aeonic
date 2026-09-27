import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents, storageObjects } from '../db/schema.js'
import { JobExecutionError, type JobHandler } from '../jobs/runner.js'
import { StorageError, type StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { convertOfficeToPdf, type DocumentLimits, inspectPdf } from './document-processor.js'
import { MediaCommandError } from './subprocess.js'
import { inspectVideo, type VideoLimits } from './video-processor.js'

interface InspectionPayload {
  assetId: string
  assetVersionId: string
  storageObjectId: string
}

function readPayload(value: Record<string, unknown>): InspectionPayload {
  const values = [value.assetId, value.assetVersionId, value.storageObjectId]
  if (values.some((item) => typeof item !== 'string' || !isUuid(item))) {
    throw new JobExecutionError('invalid_job_payload', 'The inspection payload is invalid.', false)
  }
  return {
    assetId: values[0] as string,
    assetVersionId: values[1] as string,
    storageObjectId: values[2] as string,
  }
}

type NonImageKind = 'video' | 'document'

export class NonImageInspectionHandler {
  constructor(
    private readonly kind: NonImageKind,
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
    private readonly limits: { video: VideoLimits; document: DocumentLimits },
  ) {}

  readonly handle: JobHandler = async (job, context) => {
    const identifiers = readPayload(job.payload)
    const row = this.database.db
      .select({
        assetState: assets.state,
        mediaKind: assets.mediaKind,
        versionState: assetVersions.state,
        mimeType: assetVersions.mimeType,
        storageState: storageObjects.state,
        storageKey: storageObjects.objectKey,
      })
      .from(assetVersions)
      .innerJoin(
        assets,
        and(
          eq(assets.id, assetVersions.assetId),
          eq(assets.organizationId, assetVersions.organizationId),
          eq(assets.projectId, assetVersions.projectId),
        ),
      )
      .innerJoin(
        storageObjects,
        and(
          eq(storageObjects.id, assetVersions.storageObjectId),
          eq(storageObjects.organizationId, assetVersions.organizationId),
          eq(storageObjects.projectId, assetVersions.projectId),
        ),
      )
      .where(
        and(
          eq(assetVersions.id, identifiers.assetVersionId),
          eq(assetVersions.assetId, identifiers.assetId),
          eq(assetVersions.storageObjectId, identifiers.storageObjectId),
          eq(assetVersions.organizationId, job.organizationId),
          eq(assetVersions.projectId, job.projectId),
        ),
      )
      .get()
    if (row?.mediaKind !== this.kind || !row.mimeType) {
      throw new JobExecutionError(
        'inspection_target_missing',
        'The inspection target is unavailable.',
        false,
      )
    }
    if (row.assetState === 'ready' && row.versionState === 'ready') return
    if (
      row.assetState !== 'processing' ||
      row.versionState !== 'processing' ||
      row.storageState !== 'available'
    ) {
      throw new JobExecutionError(
        'inspection_target_invalid',
        'The inspection target is not processable.',
        false,
      )
    }
    context.reportProgress(10)
    try {
      const scope = { organizationId: job.organizationId, projectId: job.projectId }
      const source = await this.storage.port.open(scope, row.storageKey as StorageObjectKey, {
        signal: context.signal,
      })
      const inspection =
        this.kind === 'video'
          ? await inspectVideo(source, row.mimeType, this.limits.video, context.signal)
          : await this.inspectDocument(source, row.mimeType, context.signal)
      context.reportProgress(80)
      this.publish(job, identifiers, inspection)
    } catch (error) {
      if (error instanceof StorageError) {
        throw new JobExecutionError(
          `storage_${error.code}`,
          'The original could not be read from storage.',
          error.retryable,
          { cause: error },
        )
      }
      const code =
        error instanceof MediaCommandError
          ? error.code
          : error instanceof RangeError || error instanceof TypeError
            ? 'media_limit_exceeded'
            : null
      if (code) {
        this.reject(job, identifiers, code)
        throw new JobExecutionError(code, 'Media inspection rejected the asset.', false, {
          cause: error,
        })
      }
      throw error
    }
  }

  private async inspectDocument(source: Readable, mimeType: string, signal: AbortSignal) {
    if (mimeType === 'application/pdf') return inspectPdf(source, this.limits.document, signal)
    const pdf = await convertOfficeToPdf(source, mimeType, this.limits.document, signal)
    return inspectPdf(Readable.from(pdf), this.limits.document, signal)
  }

  private publish(
    job: Parameters<JobHandler>[0],
    identifiers: InspectionPayload,
    inspection: Awaited<ReturnType<typeof inspectVideo>> | Awaited<ReturnType<typeof inspectPdf>>,
  ): void {
    const now = new Date()
    const video = 'durationSeconds' in inspection
    this.database.db.transaction((transaction) => {
      transaction
        .update(assetVersions)
        .set({
          state: 'ready',
          width: Math.round(video ? inspection.width : inspection.widthPoints),
          height: Math.round(video ? inspection.height : inspection.heightPoints),
          ...(video ? { durationMs: Math.round(inspection.durationSeconds * 1000) } : {}),
          metadata: { inspection },
        })
        .where(
          and(
            eq(assetVersions.id, identifiers.assetVersionId),
            eq(assetVersions.state, 'processing'),
          ),
        )
        .run()
      transaction
        .update(assets)
        .set({ state: 'ready', updatedAt: now })
        .where(and(eq(assets.id, identifiers.assetId), eq(assets.state, 'processing')))
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: job.organizationId,
          projectId: job.projectId,
          actorType: 'system',
          actorId: null,
          action: 'asset.inspected',
          targetType: 'asset',
          targetId: identifiers.assetId,
          requestId: `job:${job.id}`,
          summary: { assetVersionId: identifiers.assetVersionId, mediaKind: this.kind, inspection },
          createdAt: now,
        })
        .run()
    })
  }

  private reject(
    job: Parameters<JobHandler>[0],
    identifiers: InspectionPayload,
    reason: string,
  ): void {
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(assetVersions)
        .set({ state: 'rejected' })
        .where(eq(assetVersions.id, identifiers.assetVersionId))
        .run()
      transaction
        .update(assets)
        .set({ state: 'rejected', updatedAt: now })
        .where(eq(assets.id, identifiers.assetId))
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: job.organizationId,
          projectId: job.projectId,
          actorType: 'system',
          actorId: null,
          action: 'asset.inspection_failed',
          targetType: 'asset',
          targetId: identifiers.assetId,
          requestId: `job:${job.id}`,
          summary: { assetVersionId: identifiers.assetVersionId, reason },
          createdAt: now,
        })
        .run()
    })
  }
}
