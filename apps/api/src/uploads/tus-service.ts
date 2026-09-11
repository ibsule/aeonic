import { createHash } from 'node:crypto'
import { type Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UploadQuery } from '@aeonic/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import {
  assets,
  assetVersions,
  auditEvents,
  projectApiKeys,
  projects,
  storageObjects,
  uploads,
} from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import {
  createStorageObjectKey,
  StorageError,
  type StorageObjectKey,
} from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { UploadFinalizer, type UploadReservation } from './finalizer.js'
import type { TusChecksum, TusMetadata } from './tus-protocol.js'
import {
  TusChecksumMismatchError,
  TusOffsetMismatchError,
  type TusStagingStore,
} from './tus-staging.js'
import { validateUploadDescriptor } from './validation.js'

type TusUploadState =
  | 'created'
  | 'receiving'
  | 'validating'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'terminated'

interface TusRow {
  uploadId: string
  organizationId: string
  projectId: string
  state: TusUploadState
  expectedBytes: number
  receivedBytes: number
  uploadMetadata: string
  expiresAt: Date
  assetId: string
  assetVersionId: string
  storageObjectId: string
  storageKey: StorageObjectKey
  publicId: string
  name: string
  folder: string
  visibility: 'private' | 'public'
  mediaKind: 'image' | 'video' | 'document'
  filename: string
  mimeType: string
  createdBy: string
  createdAt: Date
}

export interface TusCreatedUpload {
  uploadId: string
  assetId: string
  publicId: string
  expiresAt: Date
}

export interface TusUploadStatus {
  uploadId: string
  assetId: string
  publicId: string
  state: TusUploadState
  offset: number
  length: number
  metadata: string
  expiresAt: Date | null
}

export interface TusReconciliationResult {
  inspected: number
  repaired: number
  finalized: number
  expired: number
  cleaned: number
  failed: number
}

interface TusCreateRequest {
  principal: Principal
  scope: TenantScope
  metadata: TusMetadata
  length: number
  requestId: string
}

interface TusAppendRequest {
  principal: Principal
  scope: TenantScope
  uploadId: string
  offset: number
  contentLength?: number
  checksum?: TusChecksum
  requestId: string
  source: Readable
  signal: AbortSignal
}

interface TusAccessRequest {
  principal: Principal
  scope: TenantScope
  uploadId: string
  requestId: string
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'Upload not found',
    'upload_not_found',
    'The resumable upload does not exist.',
  )
}

function gone(state: 'expired' | 'terminated' | 'failed' | 'rejected'): ApiError {
  return new ApiError(
    410,
    'Upload unavailable',
    `upload_${state}`,
    'The resumable upload can no longer be continued.',
  )
}

function storageFailure(error: StorageError): ApiError {
  return new ApiError(
    error.retryable ? 503 : 500,
    'Upload storage failed',
    `storage_${error.code}`,
    error.retryable
      ? 'Upload storage is temporarily unavailable; retry the request.'
      : 'The resumable upload could not be stored.',
  )
}

async function streamSha256(source: Readable, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(
    source,
    new Writable({
      write(chunk: Buffer | string, encoding, callback) {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
        callback()
      },
    }),
    { signal },
  )
  return hash.digest('hex')
}

export class TusUploadService {
  readonly #finalizer: UploadFinalizer
  readonly #locks = new Map<string, Promise<void>>()

  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly storage: StorageRuntime,
    private readonly staging: TusStagingStore,
    private readonly limits: Pick<
      AppConfig,
      'projectStorageQuotaBytes' | 'tusUploadMaxBytes' | 'tusUploadExpirationMs'
    >,
  ) {
    this.#finalizer = new UploadFinalizer(database, storage)
  }

  async initialize(): Promise<void> {
    await this.staging.initialize()
  }

  async #exclusive<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(uploadId) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = previous.then(() => current)
    this.#locks.set(uploadId, chain)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.#locks.get(uploadId) === chain) this.#locks.delete(uploadId)
    }
  }

  #creatorFor(principal: Principal, scope: TenantScope): string {
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

  #descriptor(metadata: TusMetadata) {
    const name = metadata.values.get('name')
    const folder = metadata.values.get('folder')
    const visibility = metadata.values.get('visibility')
    if (visibility !== undefined && visibility !== 'private' && visibility !== 'public') {
      throw new ApiError(
        400,
        'Invalid resumable upload',
        'invalid_upload_metadata',
        'The visibility metadata must be private or public.',
      )
    }
    const query: UploadQuery = {
      filename: metadata.values.get('filename') as string,
      ...(name === undefined ? {} : { name }),
      ...(folder === undefined ? {} : { folder }),
      ...(visibility === undefined ? {} : { visibility }),
    }
    return validateUploadDescriptor(query, metadata.values.get('filetype'))
  }

  #assertProject(scope: TenantScope): void {
    const exists = this.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, scope.projectId),
          eq(projects.organizationId, scope.organizationId),
          isNull(projects.deletedAt),
        ),
      )
      .get()
    if (!exists) {
      throw new ApiError(
        404,
        'Project not found',
        'project_not_found',
        'The project does not exist.',
      )
    }
  }

  async create(request: TusCreateRequest): Promise<TusCreatedUpload> {
    const createdBy = this.#creatorFor(request.principal, request.scope)
    this.#assertProject(request.scope)
    if (request.length <= 0 || request.length > this.limits.tusUploadMaxBytes) {
      throw new ApiError(
        413,
        'Upload too large',
        'upload_too_large',
        'Upload-Length exceeds the configured resumable-upload limit.',
      )
    }
    const descriptor = this.#descriptor(request.metadata)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.limits.tusUploadExpirationMs)
    const uploadId = uuidv7()
    const assetId = uuidv7()
    const assetVersionId = uuidv7()
    const storageObjectId = uuidv7()
    const publicId = uuidv7()
    const storageKey = createStorageObjectKey(request.scope, 'original', uuidv7())

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
      if ((stored ?? 0) + (reserved ?? 0) + request.length > this.limits.projectStorageQuotaBytes) {
        throw new ApiError(
          413,
          'Project quota exceeded',
          'project_storage_quota_exceeded',
          'The upload would exceed the project storage quota.',
        )
      }

      transaction
        .insert(assets)
        .values({
          id: assetId,
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          publicId,
          name: descriptor.name,
          folder: descriptor.folder,
          mediaKind: descriptor.mediaKind,
          visibility: descriptor.visibility,
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
          id: storageObjectId,
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          backend: this.storage.backend,
          namespace: 'original',
          objectKey: storageKey,
          state: 'staging',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      transaction
        .insert(assetVersions)
        .values({
          id: assetVersionId,
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          assetId,
          version: 1,
          state: 'uploading',
          storageObjectId,
          createdBy,
          createdAt: now,
        })
        .run()
      transaction
        .insert(uploads)
        .values({
          id: uploadId,
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          assetId,
          storageObjectId,
          protocol: 'tus',
          state: 'receiving',
          expectedBytes: request.length,
          originalFilename: descriptor.filename,
          declaredMimeType: descriptor.declaredMimeType,
          uploadMetadata: request.metadata.raw,
          expiresAt,
          createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          actorType: request.principal.type,
          actorId:
            request.principal.type === 'user' ? request.principal.userId : request.principal.keyId,
          action: 'upload.created',
          targetType: 'upload',
          targetId: uploadId,
          requestId: request.requestId,
          summary: { protocol: 'tus', expectedBytes: request.length },
          createdAt: now,
        })
        .run()
    })

    try {
      await this.staging.create(uploadId)
    } catch (error) {
      this.#markTerminal(
        uploadId,
        assetId,
        assetVersionId,
        storageObjectId,
        'failed',
        'staging_failed',
      )
      if (error instanceof StorageError) throw storageFailure(error)
      throw error
    }
    return { uploadId, assetId, publicId, expiresAt }
  }

  #row(scope: TenantScope, uploadId: string): TusRow {
    const row = this.database.db
      .select({
        uploadId: uploads.id,
        organizationId: uploads.organizationId,
        projectId: uploads.projectId,
        state: uploads.state,
        expectedBytes: uploads.expectedBytes,
        receivedBytes: uploads.receivedBytes,
        uploadMetadata: uploads.uploadMetadata,
        expiresAt: uploads.expiresAt,
        assetId: assets.id,
        assetVersionId: assetVersions.id,
        storageObjectId: storageObjects.id,
        storageKey: storageObjects.objectKey,
        publicId: assets.publicId,
        name: assets.name,
        folder: assets.folder,
        visibility: assets.visibility,
        mediaKind: assets.mediaKind,
        filename: uploads.originalFilename,
        mimeType: uploads.declaredMimeType,
        createdBy: uploads.createdBy,
        createdAt: uploads.createdAt,
      })
      .from(uploads)
      .innerJoin(assets, eq(assets.id, uploads.assetId))
      .innerJoin(assetVersions, eq(assetVersions.assetId, assets.id))
      .innerJoin(storageObjects, eq(storageObjects.id, uploads.storageObjectId))
      .where(
        and(
          eq(uploads.id, uploadId),
          eq(uploads.protocol, 'tus'),
          eq(uploads.organizationId, scope.organizationId),
          eq(uploads.projectId, scope.projectId),
          eq(assetVersions.version, 1),
        ),
      )
      .get()
    if (
      !row ||
      row.expectedBytes === null ||
      row.uploadMetadata === null ||
      row.expiresAt === null ||
      row.filename === null ||
      row.mimeType === null
    ) {
      throw notFound()
    }
    return {
      ...row,
      expectedBytes: row.expectedBytes,
      uploadMetadata: row.uploadMetadata,
      expiresAt: row.expiresAt,
      filename: row.filename,
      mimeType: row.mimeType,
      storageKey: row.storageKey as StorageObjectKey,
    }
  }

  async #active(request: TusAccessRequest, includeCompleted = true): Promise<TusRow> {
    this.#creatorFor(request.principal, request.scope)
    const row = this.#row(request.scope, request.uploadId)
    if (row.state === 'expired' || row.state === 'terminated') throw gone(row.state)
    if (row.state === 'failed' || row.state === 'rejected') throw gone(row.state)
    if (!includeCompleted && row.state === 'completed') {
      throw new ApiError(
        409,
        'Upload complete',
        'upload_complete',
        'The upload is already complete.',
      )
    }
    if (row.state !== 'completed' && row.expiresAt.getTime() <= Date.now()) {
      await this.#expire(row, request.requestId)
      throw gone('expired')
    }
    return row
  }

  async status(request: TusAccessRequest): Promise<TusUploadStatus> {
    return this.#exclusive(request.uploadId, async () => {
      const row = await this.#active(request)
      await this.#repairStagingOffset(row)
      return {
        uploadId: row.uploadId,
        assetId: row.assetId,
        publicId: row.publicId,
        state: row.state,
        offset: row.receivedBytes,
        length: row.expectedBytes,
        metadata: row.uploadMetadata,
        expiresAt: row.state === 'completed' ? null : row.expiresAt,
      }
    })
  }

  async append(request: TusAppendRequest): Promise<TusUploadStatus> {
    return this.#exclusive(request.uploadId, async () => {
      const row = await this.#active(request)
      if (request.offset !== row.receivedBytes) {
        request.source.resume()
        throw new ApiError(
          409,
          'Upload offset mismatch',
          'upload_offset_mismatch',
          'Upload-Offset does not match the current resumable upload offset.',
        )
      }
      await this.#repairStagingOffset(row)
      const remaining = row.expectedBytes - row.receivedBytes
      if (request.contentLength !== undefined && request.contentLength > remaining) {
        request.source.resume()
        throw new ApiError(
          413,
          'Upload too large',
          'upload_too_large',
          'The chunk exceeds the remaining upload size.',
        )
      }

      if (row.state !== 'completed' && remaining > 0) {
        let chunkBytes: number
        try {
          chunkBytes = await this.staging.append(row.uploadId, request.source, {
            offset: row.receivedBytes,
            maxBytes: remaining,
            ...(request.checksum === undefined ? {} : { checksum: request.checksum }),
            signal: request.signal,
          })
        } catch (error) {
          if (error instanceof TusChecksumMismatchError) {
            throw new ApiError(
              460,
              'Checksum mismatch',
              'checksum_mismatch',
              'The received chunk does not match Upload-Checksum.',
            )
          }
          if (error instanceof TusOffsetMismatchError) {
            throw new ApiError(
              409,
              'Upload offset mismatch',
              'upload_offset_mismatch',
              'The staged upload offset changed; request the current offset with HEAD.',
            )
          }
          if (error instanceof StorageError) throw storageFailure(error)
          throw error
        }
        if (request.contentLength !== undefined && chunkBytes !== request.contentLength) {
          await this.staging.truncate(row.uploadId, row.receivedBytes)
          throw new ApiError(
            400,
            'Invalid chunk length',
            'chunk_length_mismatch',
            'The received chunk size does not match Content-Length.',
          )
        }
        const offset = row.receivedBytes + chunkBytes
        const now = new Date()
        const expiresAt = new Date(now.getTime() + this.limits.tusUploadExpirationMs)
        this.database.db
          .update(uploads)
          .set({
            state: offset === row.expectedBytes ? 'validating' : 'receiving',
            receivedBytes: offset,
            expiresAt,
            errorCode: null,
            updatedAt: now,
          })
          .where(and(eq(uploads.id, row.uploadId), eq(uploads.receivedBytes, row.receivedBytes)))
          .run()
        row.receivedBytes = offset
        row.expiresAt = expiresAt
        row.state = offset === row.expectedBytes ? 'validating' : 'receiving'
      } else {
        request.source.resume()
      }

      if (row.receivedBytes === row.expectedBytes && row.state !== 'completed') {
        await this.#finalize(row, request)
        row.state = 'completed'
      }
      return {
        uploadId: row.uploadId,
        assetId: row.assetId,
        publicId: row.publicId,
        state: row.state,
        offset: row.receivedBytes,
        length: row.expectedBytes,
        metadata: row.uploadMetadata,
        expiresAt: row.state === 'completed' ? null : row.expiresAt,
      }
    })
  }

  async #repairStagingOffset(row: TusRow): Promise<void> {
    if (row.state === 'completed') return
    let size: number
    try {
      size = await this.staging.size(row.uploadId)
    } catch (error) {
      if (error instanceof StorageError && error.code === 'not_found') {
        this.#markTerminal(
          row.uploadId,
          row.assetId,
          row.assetVersionId,
          row.storageObjectId,
          'failed',
          'staging_missing',
        )
        throw gone('failed')
      }
      throw error
    }
    if (size > row.receivedBytes) await this.staging.truncate(row.uploadId, row.receivedBytes)
    if (size < row.receivedBytes) {
      this.#markTerminal(
        row.uploadId,
        row.assetId,
        row.assetVersionId,
        row.storageObjectId,
        'failed',
        'staging_truncated',
      )
      throw gone('failed')
    }
  }

  #reservation(
    row: TusRow,
    request: Pick<TusAccessRequest, 'scope' | 'requestId'> & { principal?: Principal },
  ): UploadReservation {
    return {
      scope: request.scope,
      uploadId: row.uploadId,
      assetId: row.assetId,
      assetVersionId: row.assetVersionId,
      storageObjectId: row.storageObjectId,
      storageKey: row.storageKey,
      publicId: row.publicId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      descriptor: {
        filename: row.filename,
        name: row.name,
        folder: row.folder,
        visibility: row.visibility,
        extension: row.filename.split('.').at(-1)?.toLowerCase() ?? '',
        declaredMimeType: row.mimeType,
        mediaKind: row.mediaKind,
      },
      actorType: request.principal?.type ?? 'system',
      actorId:
        request.principal === undefined
          ? null
          : request.principal.type === 'user'
            ? request.principal.userId
            : request.principal.keyId,
      requestId: request.requestId,
      protocol: 'tus',
    }
  }

  async #finalize(
    row: TusRow,
    request: Pick<TusAccessRequest, 'scope' | 'requestId'> & {
      principal?: Principal
      signal?: AbortSignal
    },
  ): Promise<void> {
    const sha256 = await this.staging.sha256(row.uploadId, request.signal)
    let stored: { sizeBytes: number; sha256: string }
    try {
      stored = await this.storage.port.put(
        request.scope,
        row.storageKey,
        await this.staging.open(row.uploadId),
        {
          maxBytes: row.expectedBytes,
          expectedBytes: row.expectedBytes,
          expectedSha256: sha256,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      )
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'already_exists')) {
        if (error instanceof StorageError) {
          this.database.db
            .update(uploads)
            .set({ errorCode: `storage_${error.code}`, updatedAt: new Date() })
            .where(eq(uploads.id, row.uploadId))
            .run()
          throw storageFailure(error)
        }
        throw error
      }
      const metadata = await this.storage.port.head(request.scope, row.storageKey)
      const existingSha256 = await streamSha256(
        await this.storage.port.open(request.scope, row.storageKey),
        request.signal,
      )
      if (metadata.sizeBytes !== row.expectedBytes || existingSha256 !== sha256) {
        throw new ApiError(
          500,
          'Stored object conflict',
          'storage_object_conflict',
          'The existing immutable object does not match the completed upload.',
        )
      }
      stored = { sizeBytes: metadata.sizeBytes, sha256: existingSha256 }
    }

    try {
      await this.#finalizer.finalize(this.#reservation(row, request), stored)
      await this.staging.delete(row.uploadId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 415) {
        await this.staging.delete(row.uploadId)
      }
      throw error
    }
  }

  async terminate(request: TusAccessRequest): Promise<void> {
    await this.#exclusive(request.uploadId, async () => {
      const row = await this.#active(request)
      if (row.state !== 'completed') {
        await this.staging.delete(row.uploadId)
        try {
          await this.storage.port.delete(request.scope, row.storageKey)
        } catch (error) {
          if (!(error instanceof StorageError && error.code === 'not_found')) throw error
        }
        this.#markTerminal(
          row.uploadId,
          row.assetId,
          row.assetVersionId,
          row.storageObjectId,
          'terminated',
          'terminated',
        )
      } else {
        this.database.db
          .update(uploads)
          .set({ state: 'terminated', errorCode: 'terminated', updatedAt: new Date() })
          .where(eq(uploads.id, row.uploadId))
          .run()
      }
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          actorType: request.principal.type,
          actorId:
            request.principal.type === 'user' ? request.principal.userId : request.principal.keyId,
          action: 'upload.terminated',
          targetType: 'upload',
          targetId: row.uploadId,
          requestId: request.requestId,
          summary: { completed: row.state === 'completed' },
          createdAt: new Date(),
        })
        .run()
    })
  }

  async #expire(row: TusRow, requestId: string): Promise<void> {
    await this.staging.delete(row.uploadId)
    try {
      await this.storage.port.delete(
        { organizationId: row.organizationId, projectId: row.projectId },
        row.storageKey,
      )
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'not_found')) throw error
    }
    this.#markTerminal(
      row.uploadId,
      row.assetId,
      row.assetVersionId,
      row.storageObjectId,
      'expired',
      'expired',
    )
    this.database.db
      .insert(auditEvents)
      .values({
        id: uuidv7(),
        organizationId: row.organizationId,
        projectId: row.projectId,
        actorType: 'system',
        action: 'upload.expired',
        targetType: 'upload',
        targetId: row.uploadId,
        requestId,
        summary: { receivedBytes: row.receivedBytes, expectedBytes: row.expectedBytes },
        createdAt: new Date(),
      })
      .run()
  }

  #markTerminal(
    uploadId: string,
    assetId: string,
    assetVersionId: string,
    storageObjectId: string,
    state: 'failed' | 'expired' | 'terminated',
    errorCode: string,
  ): void {
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(uploads)
        .set({ state, errorCode, updatedAt: now })
        .where(eq(uploads.id, uploadId))
        .run()
      transaction
        .update(assets)
        .set({ state: state === 'failed' ? 'failed' : 'rejected', updatedAt: now })
        .where(eq(assets.id, assetId))
        .run()
      transaction
        .update(assetVersions)
        .set({ state: state === 'failed' ? 'failed' : 'rejected' })
        .where(eq(assetVersions.id, assetVersionId))
        .run()
      transaction
        .update(storageObjects)
        .set({ state: 'deleted', errorCode, deletedAt: now, updatedAt: now })
        .where(eq(storageObjects.id, storageObjectId))
        .run()
    })
  }

  async reconcile(now = new Date()): Promise<TusReconciliationResult> {
    await this.initialize()
    const candidates = this.database.db
      .select({
        uploadId: uploads.id,
        organizationId: uploads.organizationId,
        projectId: uploads.projectId,
      })
      .from(uploads)
      .where(
        and(
          eq(uploads.protocol, 'tus'),
          inArray(uploads.state, ['created', 'receiving', 'validating', 'completed']),
        ),
      )
      .limit(100)
      .all()
    const result: TusReconciliationResult = {
      inspected: candidates.length,
      repaired: 0,
      finalized: 0,
      expired: 0,
      cleaned: 0,
      failed: 0,
    }

    for (const candidate of candidates) {
      await this.#exclusive(candidate.uploadId, async () => {
        try {
          const scope = {
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
          }
          const row = this.#row(scope, candidate.uploadId)
          if (row.state === 'completed') {
            await this.staging.delete(row.uploadId)
            result.cleaned += 1
            return
          }
          if (row.expiresAt.getTime() <= now.getTime()) {
            await this.#expire(row, uuidv7())
            result.expired += 1
            return
          }
          const before = await this.staging.size(row.uploadId)
          await this.#repairStagingOffset(row)
          if (before > row.receivedBytes) result.repaired += 1
          if (row.receivedBytes === row.expectedBytes) {
            await this.#finalize(row, { scope, requestId: uuidv7() })
            result.finalized += 1
          }
        } catch {
          result.failed += 1
        }
      })
    }
    return result
  }
}
