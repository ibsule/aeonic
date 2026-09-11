import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents, jobs, storageObjects, uploads } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { TenantScope } from '../repositories/types.js'
import { StorageError } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { UploadContentError, type UploadDescriptor, validateStoredContent } from './validation.js'

export interface UploadReservation {
  scope: TenantScope
  uploadId: string
  assetId: string
  assetVersionId: string
  storageObjectId: string
  storageKey: Parameters<StorageRuntime['port']['put']>[1]
  publicId: string
  createdBy: string
  createdAt: Date
  descriptor: UploadDescriptor
  actorType: Principal['type'] | 'system'
  actorId: string | null
  requestId: string
  protocol: 'simple' | 'tus'
}

export interface FinalizedUpload {
  sizeBytes: number
  sha256: string
}

export class UploadFinalizer {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
  ) {}

  private markValidating(reservation: UploadReservation, sizeBytes: number, sha256: string): void {
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(uploads)
        .set({
          state: 'validating',
          receivedBytes: sizeBytes,
          actualChecksum: sha256,
          updatedAt: now,
        })
        .where(eq(uploads.id, reservation.uploadId))
        .run()
      transaction
        .update(assets)
        .set({ state: 'validating', updatedAt: now })
        .where(eq(assets.id, reservation.assetId))
        .run()
      transaction
        .update(assetVersions)
        .set({ state: 'validating' })
        .where(eq(assetVersions.id, reservation.assetVersionId))
        .run()
    })
  }

  private complete(reservation: UploadReservation, sizeBytes: number, sha256: string): void {
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(storageObjects)
        .set({
          state: 'available',
          sizeBytes,
          sha256,
          finalizedAt: now,
          updatedAt: now,
        })
        .where(eq(storageObjects.id, reservation.storageObjectId))
        .run()
      transaction
        .update(assetVersions)
        .set({
          state: 'processing',
          mimeType: reservation.descriptor.declaredMimeType,
          sizeBytes,
          sha256,
        })
        .where(eq(assetVersions.id, reservation.assetVersionId))
        .run()
      transaction
        .update(assets)
        .set({ state: 'processing', currentVersion: 1, updatedAt: now })
        .where(eq(assets.id, reservation.assetId))
        .run()
      transaction
        .update(uploads)
        .set({
          state: 'completed',
          detectedMimeType: reservation.descriptor.declaredMimeType,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(uploads.id, reservation.uploadId))
        .run()
      transaction
        .insert(jobs)
        .values({
          id: uuidv7(),
          organizationId: reservation.scope.organizationId,
          projectId: reservation.scope.projectId,
          type: 'media.inspect',
          state: 'queued',
          payload: {
            assetId: reservation.assetId,
            assetVersionId: reservation.assetVersionId,
            storageObjectId: reservation.storageObjectId,
          },
          runAfter: now,
          createdBy: reservation.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: reservation.scope.organizationId,
          projectId: reservation.scope.projectId,
          actorType: reservation.actorType,
          actorId: reservation.actorId,
          action: 'asset.uploaded',
          targetType: 'asset',
          targetId: reservation.assetId,
          requestId: reservation.requestId,
          summary: {
            uploadId: reservation.uploadId,
            protocol: reservation.protocol,
            mimeType: reservation.descriptor.declaredMimeType,
            sizeBytes,
            sha256,
          },
          createdAt: now,
        })
        .run()
    })
  }

  private async rejectContent(
    reservation: UploadReservation,
    error: UploadContentError,
  ): Promise<void> {
    const now = new Date()
    let objectState: 'deleted' | 'failed' = 'deleted'
    try {
      await this.storage.port.delete(reservation.scope, reservation.storageKey)
    } catch (deleteError) {
      if (!(deleteError instanceof StorageError && deleteError.code === 'not_found')) {
        objectState = 'failed'
      }
    }
    this.database.db.transaction((transaction) => {
      transaction
        .update(storageObjects)
        .set({
          state: objectState,
          errorCode: objectState === 'failed' ? 'cleanup_failed' : error.code,
          ...(objectState === 'deleted' ? { deletedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(storageObjects.id, reservation.storageObjectId))
        .run()
      transaction
        .update(uploads)
        .set({ state: 'rejected', errorCode: error.code, updatedAt: now })
        .where(eq(uploads.id, reservation.uploadId))
        .run()
      transaction
        .update(assets)
        .set({ state: 'rejected', updatedAt: now })
        .where(eq(assets.id, reservation.assetId))
        .run()
      transaction
        .update(assetVersions)
        .set({ state: 'rejected' })
        .where(eq(assetVersions.id, reservation.assetVersionId))
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: reservation.scope.organizationId,
          projectId: reservation.scope.projectId,
          actorType: reservation.actorType,
          actorId: reservation.actorId,
          action: 'upload.rejected',
          targetType: 'upload',
          targetId: reservation.uploadId,
          requestId: reservation.requestId,
          summary: { reason: error.code },
          createdAt: now,
        })
        .run()
    })
  }

  async finalize(
    reservation: UploadReservation,
    stored: FinalizedUpload,
  ): Promise<FinalizedUpload> {
    this.markValidating(reservation, stored.sizeBytes, stored.sha256)
    try {
      await validateStoredContent(
        this.storage.port,
        reservation.scope,
        reservation.storageKey,
        reservation.descriptor,
      )
    } catch (error) {
      if (error instanceof UploadContentError) {
        await this.rejectContent(reservation, error)
        throw new ApiError(415, 'Unsupported media', error.code, error.message)
      }
      throw error
    }
    this.complete(reservation, stored.sizeBytes, stored.sha256)
    return stored
  }
}
