import type { Readable } from 'node:stream'
import type { CanonicalImageTransformV1 } from '@aeonic/contracts'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import { derivatives, storageObjects } from '../db/schema.js'
import type { OriginalAsset } from '../delivery/service.js'
import { ApiError } from '../http/api-error.js'
import { inspectImage } from '../media/image-inspector.js'
import {
  type ImageOutputFormat,
  imageProcessorFingerprint,
  transformImage,
} from '../media/image-transformer.js'
import type { TenantScope } from '../repositories/types.js'
import {
  createStorageObjectKey,
  StorageError,
  type StorageObjectKey,
} from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { createDerivativeCacheKey } from './cache-key.js'
import { DerivativeLeaseLostError, SqliteDerivativeRepository } from './repository.js'

export interface ImageDerivative {
  readonly id: string
  readonly scope: TenantScope
  readonly canonicalSpec: string
  readonly outputFormat: ImageOutputFormat
  readonly mimeType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly finalizedAt: Date
  readonly storageKey: StorageObjectKey
  readonly storageBackend: 'local' | 's3'
}

export class DerivativeGenerationPendingError extends Error {
  override readonly name = 'DerivativeGenerationPendingError'
}

type ImageDerivativeConfig = Pick<
  AppConfig,
  'imageMaxFrames' | 'imageMaxInputPixels' | 'imageMaxOutputBytes' | 'imageTransformTimeoutMs'
>

function generationCode(error: unknown): string {
  if (error instanceof StorageError) return `storage_${error.code}`
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'transform_timeout'
  if (error instanceof Error && error.name === 'ImageTransformError') return 'transform_rejected'
  return 'transform_failed'
}

export class ImageDerivativeService {
  readonly #repository: SqliteDerivativeRepository

  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: StorageRuntime,
    private readonly config: ImageDerivativeConfig,
  ) {
    this.#repository = new SqliteDerivativeRepository(database)
  }

  async resolve(
    source: OriginalAsset,
    transform: CanonicalImageTransformV1,
    outputFormat: ImageOutputFormat,
    owner: string,
    signal?: AbortSignal,
  ): Promise<ImageDerivative> {
    if (source.mediaKind !== 'image') {
      throw new ApiError(
        415,
        'Unsupported media type',
        'image_transform_required',
        'Image transformations require an image asset.',
      )
    }
    const processorFingerprint = imageProcessorFingerprint()
    const cacheKey = createDerivativeCacheKey({
      sourceSha256: source.sha256,
      canonicalSpec: transform.canonicalSpec,
      outputFormat,
      processorFingerprint,
    })
    const cached = this.ready(source.scope, cacheKey)
    if (cached) return cached

    const now = new Date()
    const timeout = AbortSignal.timeout(this.config.imageTransformTimeoutMs)
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const leaseUntil = new Date(now.getTime() + this.config.imageTransformTimeoutMs + 5_000)
    const acquired = this.#repository.acquire(
      {
        ...source.scope,
        assetVersionId: source.versionId,
        cacheKey,
        canonicalSpec: transform.canonicalSpec,
        outputFormat,
        processorFingerprint,
      },
      owner,
      now,
      leaseUntil,
    )
    if (!acquired.acquired) {
      const ready = this.ready(source.scope, cacheKey)
      if (ready) return ready
      throw new DerivativeGenerationPendingError('The derivative is already being generated.')
    }

    const storageObjectId = uuidv7()
    const storageKey = createStorageObjectKey(source.scope, 'derivative', storageObjectId)
    this.database.db
      .insert(storageObjects)
      .values({
        id: storageObjectId,
        ...source.scope,
        backend: this.storage.backend,
        namespace: 'derivative',
        objectKey: storageKey,
        state: 'staging',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    try {
      combinedSignal.throwIfAborted()
      const original = await this.openOriginal(source, combinedSignal)
      const transformed = await transformImage(
        original,
        transform.plan,
        outputFormat,
        {
          maxInputPixels: this.config.imageMaxInputPixels,
          maxFrames: this.config.imageMaxFrames,
        },
        combinedSignal,
      )
      const stored = await this.storage.port.put(source.scope, storageKey, transformed.stream, {
        maxBytes: this.config.imageMaxOutputBytes,
        signal: combinedSignal,
      })
      const validationSource = await this.storage.port.open(source.scope, storageKey, {
        signal: combinedSignal,
      })
      const inspected = await inspectImage(
        validationSource,
        transformed.mimeType,
        {
          maxInputPixels: this.config.imageMaxInputPixels,
          maxFrames: this.config.imageMaxFrames,
        },
        combinedSignal,
      )
      const completedAt = new Date()
      this.database.db
        .update(storageObjects)
        .set({
          state: 'available',
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          finalizedAt: completedAt,
          updatedAt: completedAt,
          errorCode: null,
        })
        .where(eq(storageObjects.id, storageObjectId))
        .run()
      this.#repository.complete(acquired.derivative.id, owner, completedAt, {
        storageObjectId,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        mimeType: transformed.mimeType,
        width: inspected.width,
        height: inspected.height,
      })
      return this.ready(source.scope, cacheKey) as ImageDerivative
    } catch (error) {
      await this.discard(source.scope, storageObjectId, storageKey, generationCode(error))
      try {
        this.#repository.fail(acquired.derivative.id, owner, new Date(), generationCode(error))
      } catch (leaseError) {
        if (!(leaseError instanceof DerivativeLeaseLostError)) throw leaseError
      }
      throw error
    }
  }

  async open(
    derivative: ImageDerivative,
    range: { start: number; end: number } | undefined,
    signal: AbortSignal,
  ): Promise<Readable> {
    if (derivative.storageBackend !== this.storage.backend) {
      throw new ApiError(
        503,
        'Derivative unavailable',
        'storage_backend_unavailable',
        'The derivative storage backend is not active.',
      )
    }
    return this.storage.port.open(derivative.scope, derivative.storageKey, {
      ...(range ? { range } : {}),
      signal,
    })
  }

  private ready(scope: TenantScope, cacheKey: string): ImageDerivative | null {
    const row = this.database.db
      .select({
        id: derivatives.id,
        organizationId: derivatives.organizationId,
        projectId: derivatives.projectId,
        canonicalSpec: derivatives.canonicalSpec,
        outputFormat: derivatives.outputFormat,
        mimeType: derivatives.mimeType,
        sizeBytes: derivatives.sizeBytes,
        sha256: derivatives.sha256,
        width: derivatives.width,
        height: derivatives.height,
        finalizedAt: storageObjects.finalizedAt,
        storageKey: storageObjects.objectKey,
        storageBackend: storageObjects.backend,
      })
      .from(derivatives)
      .innerJoin(
        storageObjects,
        and(
          eq(storageObjects.id, derivatives.storageObjectId),
          eq(storageObjects.organizationId, derivatives.organizationId),
          eq(storageObjects.projectId, derivatives.projectId),
        ),
      )
      .where(
        and(
          eq(derivatives.organizationId, scope.organizationId),
          eq(derivatives.projectId, scope.projectId),
          eq(derivatives.cacheKey, cacheKey),
          eq(derivatives.state, 'ready'),
          eq(storageObjects.state, 'available'),
        ),
      )
      .get()
    if (
      !row?.mimeType ||
      row.sizeBytes === null ||
      !row.sha256 ||
      row.width === null ||
      row.height === null ||
      !row.finalizedAt
    ) {
      return null
    }
    return {
      id: row.id,
      scope: { organizationId: row.organizationId, projectId: row.projectId },
      canonicalSpec: row.canonicalSpec,
      outputFormat: row.outputFormat as ImageOutputFormat,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      finalizedAt: row.finalizedAt,
      storageKey: row.storageKey as StorageObjectKey,
      storageBackend: row.storageBackend,
    }
  }

  private async openOriginal(source: OriginalAsset, signal: AbortSignal): Promise<Readable> {
    if (source.storageBackend !== this.storage.backend) {
      throw new ApiError(
        503,
        'Asset unavailable',
        'storage_backend_unavailable',
        'The asset storage backend is not active.',
      )
    }
    return this.storage.port.open(source.scope, source.storageKey, { signal })
  }

  private async discard(
    scope: TenantScope,
    storageObjectId: string,
    storageKey: StorageObjectKey,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.storage.port.delete(scope, storageKey)
    } catch {
      // The failed storage row keeps cleanup discoverable for reconciliation.
    }
    const now = new Date()
    this.database.db
      .update(storageObjects)
      .set({ state: 'failed', errorCode, updatedAt: now })
      .where(eq(storageObjects.id, storageObjectId))
      .run()
  }
}
