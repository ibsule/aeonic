import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents, storageObjects, uploads } from '../db/schema.js'
import type { StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'

export interface ReconciliationResult {
  inspected: number
  cleaned: number
  cleanupFailed: number
}

export class UploadReconciler {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
  ) {}

  async reconcile(cutoff: Date): Promise<ReconciliationResult> {
    const candidates = this.database.db
      .select({
        uploadId: uploads.id,
        organizationId: uploads.organizationId,
        projectId: uploads.projectId,
        assetId: uploads.assetId,
        storageObjectId: uploads.storageObjectId,
        uploadState: uploads.state,
        objectKey: storageObjects.objectKey,
      })
      .from(uploads)
      .leftJoin(storageObjects, eq(storageObjects.id, uploads.storageObjectId))
      .where(
        and(
          inArray(uploads.state, ['created', 'receiving', 'validating', 'failed', 'rejected']),
          lt(uploads.updatedAt, cutoff),
          or(isNull(storageObjects.id), inArray(storageObjects.state, ['staging', 'failed'])),
        ),
      )
      .limit(100)
      .all()

    let cleaned = 0
    let cleanupFailed = 0
    for (const candidate of candidates) {
      let removed = candidate.objectKey === null
      if (candidate.objectKey !== null) {
        try {
          await this.storage.port.delete(
            { organizationId: candidate.organizationId, projectId: candidate.projectId },
            candidate.objectKey as StorageObjectKey,
          )
          removed = true
        } catch {
          removed = false
        }
      }

      const now = new Date()
      const interrupted = ['created', 'receiving', 'validating'].includes(candidate.uploadState)
      this.database.db.transaction((transaction) => {
        if (candidate.storageObjectId) {
          transaction
            .update(storageObjects)
            .set({
              state: removed ? 'deleted' : 'failed',
              errorCode: removed ? 'interrupted_upload' : 'cleanup_failed',
              ...(removed ? { deletedAt: now } : {}),
              updatedAt: now,
            })
            .where(eq(storageObjects.id, candidate.storageObjectId))
            .run()
        }
        if (interrupted) {
          transaction
            .update(uploads)
            .set({ state: 'failed', errorCode: 'interrupted_upload', updatedAt: now })
            .where(eq(uploads.id, candidate.uploadId))
            .run()
          if (candidate.assetId) {
            transaction
              .update(assets)
              .set({ state: 'failed', updatedAt: now })
              .where(eq(assets.id, candidate.assetId))
              .run()
            transaction
              .update(assetVersions)
              .set({ state: 'failed' })
              .where(eq(assetVersions.assetId, candidate.assetId))
              .run()
          }
        }
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
            actorType: 'system',
            action: 'upload.reconciled',
            targetType: 'upload',
            targetId: candidate.uploadId,
            requestId: uuidv7(),
            summary: { objectRemoved: removed, previousState: candidate.uploadState },
            createdAt: now,
          })
          .run()
      })

      if (removed) cleaned += 1
      else cleanupFailed += 1
    }

    return { inspected: candidates.length, cleaned, cleanupFailed }
  }
}
