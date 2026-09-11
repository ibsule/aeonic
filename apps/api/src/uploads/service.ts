import type { Readable } from 'node:stream'
import type { SimpleUploadResult } from '@aeonic/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import {
  assets,
  assetVersions,
  auditEvents,
  jobs,
  projectApiKeys,
  projects as projectTable,
  storageObjects,
  uploads,
} from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import { createStorageObjectKey, StorageError } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { UploadContentError, type UploadDescriptor, validateStoredContent } from './validation.js'

interface UploadRequest {
  principal: Principal
  scope: TenantScope
  descriptor: UploadDescriptor
  contentLength: number
  expectedSha256?: string
  idempotencyKey?: string
  requestId: string
  source: Readable
  signal: AbortSignal
}

interface Reservation {
  scope: TenantScope
  uploadId: string
  assetId: string
  assetVersionId: string
  storageObjectId: string
  storageKey: ReturnType<typeof createStorageObjectKey>
  publicId: string
  createdBy: string
  createdAt: Date
  descriptor: UploadDescriptor
  actorType: 'user' | 'api_key'
  actorId: string
  requestId: string
}

export interface UploadOutcome {
  replayed: boolean
  result: SimpleUploadResult
}

function quotaExceeded(): ApiError {
  return new ApiError(
    413,
    'Project quota exceeded',
    'project_storage_quota_exceeded',
    'The upload would exceed the project storage quota.',
  )
}

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    'Upload already exists',
    'idempotency_conflict',
    'This idempotency key belongs to an upload that is not complete.',
  )
}

function resultFromReservation(
  reservation: Reservation,
  sizeBytes: number,
  sha256: string,
): SimpleUploadResult {
  return {
    uploadId: reservation.uploadId,
    assetId: reservation.assetId,
    assetVersionId: reservation.assetVersionId,
    publicId: reservation.publicId,
    name: reservation.descriptor.name,
    folder: reservation.descriptor.folder,
    visibility: reservation.descriptor.visibility,
    mediaKind: reservation.descriptor.mediaKind,
    state: 'processing',
    mimeType: reservation.descriptor.declaredMimeType,
    sizeBytes,
    sha256,
    createdAt: reservation.createdAt.toISOString(),
  }
}

export class UploadService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly storage: StorageRuntime,
    private readonly limits: Pick<AppConfig, 'projectStorageQuotaBytes' | 'uploadMaxBytes'>,
  ) {}

  private creatorFor(principal: Principal, scope: TenantScope): string {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, 'upload')
      return principal.userId
    }
    const mapping = this.database.db
      .select({ createdBy: projectApiKeys.createdBy })
      .from(projectApiKeys)
      .where(
        and(
          eq(projectApiKeys.keyId, principal.keyId),
          eq(projectApiKeys.organizationId, scope.organizationId),
          eq(projectApiKeys.projectId, scope.projectId),
          isNull(projectApiKeys.revokedAt),
        ),
      )
      .get()
    if (!mapping) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'The API key is no longer active.')
    }
    return mapping.createdBy
  }

  private assertProjectExists(scope: TenantScope): void {
    const project = this.database.db
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, scope.projectId),
          eq(projectTable.organizationId, scope.organizationId),
          isNull(projectTable.deletedAt),
        ),
      )
      .get()
    if (!project) {
      throw new ApiError(
        404,
        'Project not found',
        'project_not_found',
        'The project does not exist.',
      )
    }
  }

  private completedByIdempotencyKey(
    scope: TenantScope,
    idempotencyKey: string,
  ): SimpleUploadResult | null {
    const row = this.database.db
      .select({
        uploadId: uploads.id,
        uploadState: uploads.state,
        assetId: assets.id,
        assetVersionId: assetVersions.id,
        publicId: assets.publicId,
        name: assets.name,
        folder: assets.folder,
        visibility: assets.visibility,
        mediaKind: assets.mediaKind,
        state: assets.state,
        mimeType: assetVersions.mimeType,
        sizeBytes: assetVersions.sizeBytes,
        sha256: assetVersions.sha256,
        createdAt: uploads.createdAt,
      })
      .from(uploads)
      .innerJoin(assets, eq(assets.id, uploads.assetId))
      .innerJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, 1)),
      )
      .where(
        and(
          eq(uploads.organizationId, scope.organizationId),
          eq(uploads.projectId, scope.projectId),
          eq(uploads.idempotencyKey, idempotencyKey),
        ),
      )
      .get()
    if (!row) return null
    if (
      row.uploadState !== 'completed' ||
      row.state !== 'processing' ||
      !row.mimeType ||
      row.sizeBytes === null ||
      !row.sha256
    ) {
      throw idempotencyConflict()
    }
    return {
      uploadId: row.uploadId,
      assetId: row.assetId,
      assetVersionId: row.assetVersionId,
      publicId: row.publicId,
      name: row.name,
      folder: row.folder,
      visibility: row.visibility,
      mediaKind: row.mediaKind,
      state: 'processing',
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      createdAt: row.createdAt.toISOString(),
    }
  }

  private reserve(request: UploadRequest): Reservation | SimpleUploadResult {
    const createdBy = this.creatorFor(request.principal, request.scope)
    this.assertProjectExists(request.scope)
    if (request.contentLength > this.limits.uploadMaxBytes) {
      throw new ApiError(
        413,
        'Upload too large',
        'upload_too_large',
        'The file exceeds the configured simple-upload limit.',
      )
    }
    if (request.idempotencyKey) {
      const existing = this.completedByIdempotencyKey(request.scope, request.idempotencyKey)
      if (existing) return existing
    }

    const now = new Date()
    const reservation: Reservation = {
      scope: request.scope,
      uploadId: uuidv7(),
      assetId: uuidv7(),
      assetVersionId: uuidv7(),
      storageObjectId: uuidv7(),
      storageKey: createStorageObjectKey(request.scope, 'original', uuidv7()),
      publicId: uuidv7(),
      createdBy,
      createdAt: now,
      descriptor: request.descriptor,
      actorType: request.principal.type,
      actorId:
        request.principal.type === 'user' ? request.principal.userId : request.principal.keyId,
      requestId: request.requestId,
    }

    try {
      this.database.db.transaction((transaction) => {
        const stored = transaction
          .select({ total: sql<number>`coalesce(sum(${storageObjects.sizeBytes}), 0)` })
          .from(storageObjects)
          .where(
            and(
              eq(storageObjects.organizationId, request.scope.organizationId),
              eq(storageObjects.projectId, request.scope.projectId),
              eq(storageObjects.state, 'available'),
            ),
          )
          .get()?.total
        const reserved = transaction
          .select({ total: sql<number>`coalesce(sum(${uploads.expectedBytes}), 0)` })
          .from(uploads)
          .where(
            and(
              eq(uploads.organizationId, request.scope.organizationId),
              eq(uploads.projectId, request.scope.projectId),
              inArray(uploads.state, ['created', 'receiving', 'validating']),
            ),
          )
          .get()?.total
        if (
          (stored ?? 0) + (reserved ?? 0) + request.contentLength >
          this.limits.projectStorageQuotaBytes
        ) {
          throw quotaExceeded()
        }

        transaction
          .insert(assets)
          .values({
            id: reservation.assetId,
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            publicId: reservation.publicId,
            name: request.descriptor.name,
            folder: request.descriptor.folder,
            mediaKind: request.descriptor.mediaKind,
            visibility: request.descriptor.visibility,
            state: 'uploading',
            currentVersion: 0,
            createdBy,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(storageObjects)
          .values({
            id: reservation.storageObjectId,
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            backend: this.storage.backend,
            namespace: 'original',
            objectKey: reservation.storageKey,
            state: 'staging',
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(assetVersions)
          .values({
            id: reservation.assetVersionId,
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            assetId: reservation.assetId,
            version: 1,
            state: 'uploading',
            storageObjectId: reservation.storageObjectId,
            createdBy,
            createdAt: now,
          })
          .run()
        transaction
          .insert(uploads)
          .values({
            id: reservation.uploadId,
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            assetId: reservation.assetId,
            storageObjectId: reservation.storageObjectId,
            protocol: 'simple',
            state: 'created',
            expectedBytes: request.contentLength,
            checksumAlgorithm: request.expectedSha256 ? 'sha256' : null,
            expectedChecksum: request.expectedSha256 ?? null,
            originalFilename: request.descriptor.filename,
            declaredMimeType: request.descriptor.declaredMimeType,
            idempotencyKey: request.idempotencyKey ?? null,
            createdBy,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .update(uploads)
          .set({ state: 'receiving', updatedAt: now })
          .where(eq(uploads.id, reservation.uploadId))
          .run()
      })
    } catch (error) {
      if (
        request.idempotencyKey &&
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        const existing = this.completedByIdempotencyKey(request.scope, request.idempotencyKey)
        if (existing) return existing
      }
      throw error
    }
    return reservation
  }

  private markValidating(reservation: Reservation, sizeBytes: number, sha256: string): void {
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

  private complete(reservation: Reservation, sizeBytes: number, sha256: string): void {
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
            mimeType: reservation.descriptor.declaredMimeType,
            sizeBytes,
            sha256,
          },
          createdAt: now,
        })
        .run()
    })
  }

  private async rejectContent(reservation: Reservation, error: UploadContentError): Promise<void> {
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

  private markStorageFailure(reservation: Reservation, error: StorageError): void {
    const now = new Date()
    const rejected = ['checksum_mismatch', 'size_mismatch', 'size_exceeded'].includes(error.code)
    this.database.db.transaction((transaction) => {
      transaction
        .update(storageObjects)
        .set({ state: 'failed', errorCode: error.code, updatedAt: now })
        .where(eq(storageObjects.id, reservation.storageObjectId))
        .run()
      transaction
        .update(uploads)
        .set({ state: rejected ? 'rejected' : 'failed', errorCode: error.code, updatedAt: now })
        .where(eq(uploads.id, reservation.uploadId))
        .run()
      transaction
        .update(assets)
        .set({ state: rejected ? 'rejected' : 'failed', updatedAt: now })
        .where(eq(assets.id, reservation.assetId))
        .run()
      transaction
        .update(assetVersions)
        .set({ state: rejected ? 'rejected' : 'failed' })
        .where(eq(assetVersions.id, reservation.assetVersionId))
        .run()
    })
  }

  async create(request: UploadRequest): Promise<UploadOutcome> {
    const reserved = this.reserve(request)
    if (!('storageKey' in reserved)) {
      request.source.resume()
      return { replayed: true, result: reserved }
    }

    let stored: { sizeBytes: number; sha256: string }
    try {
      stored = await this.storage.port.put(reserved.scope, reserved.storageKey, request.source, {
        maxBytes: this.limits.uploadMaxBytes,
        expectedBytes: request.contentLength,
        ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
        signal: request.signal,
      })
    } catch (error) {
      if (error instanceof StorageError) {
        this.markStorageFailure(reserved, error)
        if (error.code === 'checksum_mismatch') {
          throw new ApiError(
            422,
            'Checksum mismatch',
            'checksum_mismatch',
            'The uploaded bytes do not match Content-Digest.',
          )
        }
        if (error.code === 'size_mismatch' || error.code === 'size_exceeded') {
          throw new ApiError(400, 'Invalid upload length', error.code, error.message)
        }
        throw new ApiError(
          error.retryable ? 503 : 500,
          'Storage write failed',
          `storage_${error.code}`,
          error.retryable
            ? 'Storage is temporarily unavailable.'
            : 'The upload could not be stored.',
        )
      }
      throw error
    }

    this.markValidating(reserved, stored.sizeBytes, stored.sha256)
    try {
      await validateStoredContent(
        this.storage.port,
        reserved.scope,
        reserved.storageKey,
        reserved.descriptor,
      )
    } catch (error) {
      if (error instanceof UploadContentError) {
        await this.rejectContent(reserved, error)
        throw new ApiError(415, 'Unsupported media', error.code, error.message)
      }
      throw error
    }

    this.complete(reserved, stored.sizeBytes, stored.sha256)
    return {
      replayed: false,
      result: resultFromReservation(reserved, stored.sizeBytes, stored.sha256),
    }
  }
}
