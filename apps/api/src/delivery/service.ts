import type { Readable } from 'node:stream'
import type {
  CreateDeliveryUrlRequest,
  DeliveryDisposition,
  DeliveryUrl,
  MediaKind,
} from '@aeonic/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import {
  assets,
  assetVersions,
  auditEvents,
  projectApiKeys,
  storageObjects,
  uploads,
} from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import { StorageError, type StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { createOriginalDeliveryPath, DeliverySigner } from './signing.js'

export interface OriginalAsset {
  scope: TenantScope
  assetId: string
  publicId: string
  version: number
  visibility: 'private' | 'public'
  mediaKind: MediaKind
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  finalizedAt: Date
  storageKey: StorageObjectKey
  storageBackend: 'local' | 's3'
}

export interface SignedDeliveryQuery {
  disposition: DeliveryDisposition
  expires: number
  keyId: string
  signature: string
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'Asset not found',
    'asset_not_found',
    'The requested asset is not available.',
  )
}

export function defaultDisposition(mediaKind: MediaKind): DeliveryDisposition {
  return mediaKind === 'document' ? 'attachment' : 'inline'
}

export function effectiveDisposition(
  mediaKind: MediaKind,
  requested: DeliveryDisposition | undefined,
): DeliveryDisposition {
  return mediaKind === 'document' ? 'attachment' : (requested ?? 'inline')
}

export class DeliveryService {
  readonly #signer: DeliverySigner

  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly storage: StorageRuntime,
    private readonly config: Pick<
      AppConfig,
      'deliveryBaseUrl' | 'deliverySigningKeys' | 'deliveryUrlTtlSeconds'
    >,
  ) {
    this.#signer = new DeliverySigner(config.deliverySigningKeys)
  }

  private rowToOriginal(
    row:
      | {
          organizationId: string
          projectId: string
          assetId: string
          publicId: string
          version: number
          visibility: 'private' | 'public'
          mediaKind: MediaKind
          originalFilename: string | null
          mimeType: string | null
          sizeBytes: number | null
          sha256: string | null
          finalizedAt: Date | null
          storageKey: string
          storageBackend: 'local' | 's3'
        }
      | undefined,
  ): OriginalAsset {
    if (
      !row?.originalFilename ||
      !row.mimeType ||
      row.sizeBytes === null ||
      !row.sha256 ||
      !row.finalizedAt
    ) {
      throw notFound()
    }
    return {
      scope: { organizationId: row.organizationId, projectId: row.projectId },
      assetId: row.assetId,
      publicId: row.publicId,
      version: row.version,
      visibility: row.visibility,
      mediaKind: row.mediaKind,
      filename: row.originalFilename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      finalizedAt: row.finalizedAt,
      storageKey: row.storageKey as StorageObjectKey,
      storageBackend: row.storageBackend,
    }
  }

  private lookup(filters: ReturnType<typeof eq>[]): OriginalAsset {
    const row = this.database.db
      .select({
        organizationId: assets.organizationId,
        projectId: assets.projectId,
        assetId: assets.id,
        publicId: assets.publicId,
        version: assetVersions.version,
        visibility: assets.visibility,
        mediaKind: assets.mediaKind,
        originalFilename: uploads.originalFilename,
        mimeType: assetVersions.mimeType,
        sizeBytes: assetVersions.sizeBytes,
        sha256: assetVersions.sha256,
        finalizedAt: storageObjects.finalizedAt,
        storageKey: storageObjects.objectKey,
        storageBackend: storageObjects.backend,
      })
      .from(assets)
      .innerJoin(
        assetVersions,
        and(
          eq(assetVersions.assetId, assets.id),
          eq(assetVersions.organizationId, assets.organizationId),
          eq(assetVersions.projectId, assets.projectId),
        ),
      )
      .innerJoin(
        storageObjects,
        and(
          eq(storageObjects.id, assetVersions.storageObjectId),
          eq(storageObjects.organizationId, assets.organizationId),
          eq(storageObjects.projectId, assets.projectId),
        ),
      )
      .innerJoin(
        uploads,
        and(
          eq(uploads.storageObjectId, storageObjects.id),
          eq(uploads.organizationId, assets.organizationId),
          eq(uploads.projectId, assets.projectId),
        ),
      )
      .where(
        and(
          ...filters,
          inArray(assets.state, ['ready', 'replacing']),
          eq(assetVersions.state, 'ready'),
          eq(storageObjects.state, 'available'),
          eq(uploads.state, 'completed'),
          isNull(assets.deletedAt),
        ),
      )
      .get()
    return this.rowToOriginal(row)
  }

  findForProject(scope: TenantScope, publicId: string, version: number): OriginalAsset {
    return this.lookup([
      eq(assets.organizationId, scope.organizationId),
      eq(assets.projectId, scope.projectId),
      eq(assets.publicId, publicId),
      eq(assetVersions.version, version),
    ])
  }

  findForPublicPath(projectId: string, publicId: string, version: number): OriginalAsset {
    return this.lookup([
      eq(assets.projectId, projectId),
      eq(assets.publicId, publicId),
      eq(assetVersions.version, version),
    ])
  }

  authorize(principal: Principal, asset: OriginalAsset): void {
    if (principal.type === 'user') {
      this.projects.authorize(
        principal.userId,
        asset.scope.organizationId,
        asset.scope.projectId,
        'read',
      )
      return
    }
    const active = this.database.db
      .select({ id: projectApiKeys.keyId })
      .from(projectApiKeys)
      .where(
        and(
          eq(projectApiKeys.keyId, principal.keyId),
          eq(projectApiKeys.organizationId, asset.scope.organizationId),
          eq(projectApiKeys.projectId, asset.scope.projectId),
          isNull(projectApiKeys.revokedAt),
        ),
      )
      .get()
    if (!active) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'The API key is no longer active.')
    }
  }

  isPubliclyAuthorized(
    asset: OriginalAsset,
    path: string,
    signedQuery: SignedDeliveryQuery | null,
  ): boolean {
    if (signedQuery) {
      return this.#signer.verify({ ...signedQuery, path })
    }
    return asset.visibility === 'public'
  }

  createSignedUrl(
    principal: Principal,
    asset: OriginalAsset,
    input: CreateDeliveryUrlRequest,
    requestId: string,
    now = new Date(),
  ): DeliveryUrl {
    this.authorize(principal, asset)
    const disposition = effectiveDisposition(asset.mediaKind, input.disposition)
    const expires =
      Math.floor(now.getTime() / 1_000) +
      (input.expiresInSeconds ?? this.config.deliveryUrlTtlSeconds)
    const path = createOriginalDeliveryPath({
      projectId: asset.scope.projectId,
      publicId: asset.publicId,
      version: asset.version,
      filename: asset.filename,
    })
    const signed = this.#signer.create(path, expires, disposition)
    const url = new URL(path, this.config.deliveryBaseUrl)
    url.searchParams.set('disposition', disposition)
    url.searchParams.set('expires', String(signed.expires))
    url.searchParams.set('kid', signed.keyId)
    url.searchParams.set('signature', signed.signature)

    this.database.db
      .insert(auditEvents)
      .values({
        id: uuidv7(),
        organizationId: asset.scope.organizationId,
        projectId: asset.scope.projectId,
        actorType: principal.type,
        actorId: principal.type === 'user' ? principal.userId : principal.keyId,
        action: 'asset.delivery_url_created',
        targetType: 'asset',
        targetId: asset.assetId,
        requestId,
        summary: { version: asset.version, disposition, expiresAt: expires },
        createdAt: now,
      })
      .run()

    return { url: url.toString(), expiresAt: new Date(expires * 1_000).toISOString() }
  }

  async open(
    asset: OriginalAsset,
    range: { start: number; end: number } | undefined,
    signal: AbortSignal,
  ): Promise<Readable> {
    if (asset.storageBackend !== this.storage.backend) {
      throw new ApiError(
        503,
        'Asset unavailable',
        'storage_backend_unavailable',
        'The asset storage backend is not active.',
      )
    }
    try {
      return await this.storage.port.open(asset.scope, asset.storageKey, {
        ...(range === undefined ? {} : { range }),
        signal,
      })
    } catch (error) {
      if (error instanceof StorageError) {
        throw new ApiError(
          error.retryable ? 503 : 500,
          'Asset unavailable',
          `storage_${error.code}`,
          'The stored asset is currently unavailable.',
        )
      }
      throw error
    }
  }
}
