import { and, eq } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents, storageObjects } from '../db/schema.js'
import { JobExecutionError, type JobHandler } from '../jobs/runner.js'
import { StorageError, type StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import {
  ImageInspectionError,
  type ImageInspectionLimits,
  inspectImage,
} from './image-inspector.js'

interface InspectionPayload {
  assetId: string
  assetVersionId: string
  storageObjectId: string
}

function payload(value: Record<string, unknown>): InspectionPayload {
  const assetId = value.assetId
  const assetVersionId = value.assetVersionId
  const storageObjectId = value.storageObjectId
  if (
    typeof assetId !== 'string' ||
    !isUuid(assetId) ||
    typeof assetVersionId !== 'string' ||
    !isUuid(assetVersionId) ||
    typeof storageObjectId !== 'string' ||
    !isUuid(storageObjectId)
  ) {
    throw new JobExecutionError(
      'invalid_job_payload',
      'The image inspection job payload is invalid.',
      false,
    )
  }
  return { assetId, assetVersionId, storageObjectId }
}

export class ImageInspectionHandler {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
    private readonly limits: ImageInspectionLimits,
  ) {}

  readonly handle: JobHandler = async (job, context) => {
    const identifiers = payload(job.payload)
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

    if (row?.mediaKind !== 'image' || !row.mimeType) {
      throw new JobExecutionError(
        'inspection_target_missing',
        'The image inspection target is unavailable.',
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
        'The image inspection target is not processable.',
        false,
      )
    }

    context.reportProgress(10)
    let inspection: Awaited<ReturnType<typeof inspectImage>>
    try {
      inspection = await inspectImage(
        await this.storage.port.open(
          { organizationId: job.organizationId, projectId: job.projectId },
          row.storageKey as StorageObjectKey,
          { signal: context.signal },
        ),
        row.mimeType,
        this.limits,
        context.signal,
      )
    } catch (error) {
      if (error instanceof ImageInspectionError) {
        this.reject(job, identifiers, error)
        throw new JobExecutionError(error.code, error.message, false, { cause: error })
      }
      if (error instanceof StorageError) {
        throw new JobExecutionError(
          `storage_${error.code}`,
          'The original image could not be read from storage.',
          error.retryable,
          { cause: error },
        )
      }
      throw error
    }

    context.reportProgress(80)
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(assetVersions)
        .set({
          state: 'ready',
          width: inspection.width,
          height: inspection.height,
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
          summary: {
            assetVersionId: identifiers.assetVersionId,
            mediaKind: 'image',
            width: inspection.width,
            height: inspection.height,
            frames: inspection.frames,
            processor: inspection.processor,
          },
          createdAt: now,
        })
        .run()
    })
  }

  private reject(
    job: Parameters<JobHandler>[0],
    identifiers: InspectionPayload,
    error: ImageInspectionError,
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
          summary: { assetVersionId: identifiers.assetVersionId, reason: error.code },
          createdAt: now,
        })
        .run()
    })
  }
}
