import type { Asset, AssetList, UpdateAssetRequest } from '@aeonic/contracts'
import { and, desc, eq, isNull, like, lt, or, type SQL } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions, auditEvents } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'

export interface ListAssetsOptions {
  cursor?: string
  limit: number
  mediaKind?: 'image' | 'video' | 'document'
  query?: string
  state?: Asset['state']
  visibility?: Asset['visibility']
}

const selection = {
  id: assets.id,
  publicId: assets.publicId,
  name: assets.name,
  folder: assets.folder,
  mediaKind: assets.mediaKind,
  visibility: assets.visibility,
  state: assets.state,
  currentVersion: assets.currentVersion,
  createdAt: assets.createdAt,
  updatedAt: assets.updatedAt,
  versionId: assetVersions.id,
  versionNumber: assetVersions.version,
  versionState: assetVersions.state,
  mimeType: assetVersions.mimeType,
  sizeBytes: assetVersions.sizeBytes,
  sha256: assetVersions.sha256,
  width: assetVersions.width,
  height: assetVersions.height,
  durationMs: assetVersions.durationMs,
  metadata: assetVersions.metadata,
  versionCreatedAt: assetVersions.createdAt,
}

type AssetRow =
  ReturnType<ReturnType<DatabaseConnection['db']['select']>['from']> extends never
    ? never
    : {
        id: string
        publicId: string
        name: string
        folder: string
        mediaKind: Asset['mediaKind']
        visibility: Asset['visibility']
        state: Asset['state']
        currentVersion: number
        createdAt: Date
        updatedAt: Date
        versionId: string | null
        versionNumber: number | null
        versionState: NonNullable<Asset['version']>['state'] | null
        mimeType: string | null
        sizeBytes: number | null
        sha256: string | null
        width: number | null
        height: number | null
        durationMs: number | null
        metadata: Record<string, unknown> | null
        versionCreatedAt: Date | null
      }

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    folder: row.folder,
    mediaKind: row.mediaKind,
    visibility: row.visibility,
    state: row.state,
    currentVersion: row.currentVersion,
    version:
      row.versionId && row.versionNumber && row.versionState && row.versionCreatedAt
        ? {
            id: row.versionId,
            version: row.versionNumber,
            state: row.versionState,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            sha256: row.sha256,
            width: row.width,
            height: row.height,
            durationMs: row.durationMs,
            metadata: row.metadata,
            createdAt: row.versionCreatedAt.toISOString(),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'Asset not found', 'asset_not_found', 'The asset does not exist.')
}

export function assetEtag(asset: Pick<Asset, 'id' | 'updatedAt'>): string {
  return `"asset-${asset.id}-${new Date(asset.updatedAt).getTime()}"`
}

export class AssetService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
  ) {}

  list(principal: Principal, scope: TenantScope, options: ListAssetsOptions): AssetList {
    this.authorize(principal, scope, 'read')
    const conditions: SQL[] = [
      eq(assets.organizationId, scope.organizationId),
      eq(assets.projectId, scope.projectId),
      isNull(assets.deletedAt),
    ]
    if (options.mediaKind) conditions.push(eq(assets.mediaKind, options.mediaKind))
    if (options.state) conditions.push(eq(assets.state, options.state))
    if (options.visibility) conditions.push(eq(assets.visibility, options.visibility))
    if (options.query) {
      conditions.push(
        or(
          like(assets.name, `%${options.query}%`),
          like(assets.folder, `%${options.query}%`),
        ) as SQL,
      )
    }
    if (options.cursor) {
      if (!isUuid(options.cursor))
        throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
      const cursor = this.database.db
        .select({ id: assets.id, createdAt: assets.createdAt })
        .from(assets)
        .where(
          and(
            eq(assets.id, options.cursor),
            eq(assets.organizationId, scope.organizationId),
            eq(assets.projectId, scope.projectId),
          ),
        )
        .get()
      if (!cursor)
        throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
      conditions.push(
        or(
          lt(assets.createdAt, cursor.createdAt),
          and(eq(assets.createdAt, cursor.createdAt), lt(assets.id, cursor.id)),
        ) as SQL,
      )
    }

    const rows = this.database.db
      .select(selection)
      .from(assets)
      .leftJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, assets.currentVersion)),
      )
      .where(and(...conditions))
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(options.limit + 1)
      .all() as AssetRow[]
    const hasMore = rows.length > options.limit
    const items = rows.slice(0, options.limit).map(toAsset)
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null }
  }

  get(principal: Principal, scope: TenantScope, publicId: string): Asset {
    this.authorize(principal, scope, 'read')
    if (!isUuid(publicId)) throw notFound()
    const row = this.database.db
      .select(selection)
      .from(assets)
      .leftJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, assets.currentVersion)),
      )
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          eq(assets.publicId, publicId),
          isNull(assets.deletedAt),
        ),
      )
      .get() as AssetRow | undefined
    if (!row) throw notFound()
    return toAsset(row)
  }

  update(
    principal: Principal,
    scope: TenantScope,
    publicId: string,
    expectedEtag: string | undefined,
    input: UpdateAssetRequest,
    requestId: string,
  ): Asset {
    const actorId = this.authorize(principal, scope, 'update')
    const current = this.get(principal, scope, publicId)
    if (!expectedEtag)
      throw new ApiError(428, 'Precondition required', 'if_match_required', 'Provide If-Match.')
    if (expectedEtag !== assetEtag(current))
      throw new ApiError(412, 'Precondition failed', 'etag_mismatch', 'The asset has changed.')
    const now = new Date()
    const name = input.name?.trim() ?? current.name
    const folder = input.folder?.trim() ?? current.folder
    const visibility = input.visibility ?? current.visibility
    const changed = this.database.db
      .update(assets)
      .set({ name, folder, visibility, updatedAt: now })
      .where(
        and(
          eq(assets.id, current.id),
          eq(assets.updatedAt, new Date(current.updatedAt)),
          isNull(assets.deletedAt),
        ),
      )
      .run()
    if (changed.changes !== 1)
      throw new ApiError(412, 'Precondition failed', 'etag_mismatch', 'The asset has changed.')
    this.database.db
      .insert(auditEvents)
      .values({
        id: uuidv7(),
        ...scope,
        actorType: principal.type,
        actorId,
        action: 'asset.updated',
        targetType: 'asset',
        targetId: current.id,
        requestId,
        summary: {
          before: { name: current.name, folder: current.folder, visibility: current.visibility },
          after: { name, folder, visibility },
        },
        createdAt: now,
      })
      .run()
    return this.get(principal, scope, publicId)
  }

  private authorize(principal: Principal, scope: TenantScope, action: 'read' | 'update'): string {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, action)
      return principal.userId
    }
    if (
      principal.organizationId !== scope.organizationId ||
      principal.projectId !== scope.projectId
    ) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'You cannot perform this action.')
    }
    return principal.keyId
  }
}
