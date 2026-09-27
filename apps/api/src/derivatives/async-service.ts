import type { Readable } from 'node:stream'
import type { AsyncDerivativeKind, CreateDerivativeRequest, Derivative } from '@aeonic/contracts'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import {
  assets,
  assetVersions,
  auditEvents,
  derivatives,
  jobs,
  projectApiKeys,
  storageObjects,
} from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import type { StorageObjectKey } from '../storage/contracts.js'
import type { StorageRuntime } from '../storage/factory.js'
import { createAsyncDerivativeCacheKey } from './cache-key.js'
import type { DerivativeOutputFormat, DerivativeRecord } from './repository.js'

interface SourceRecord {
  assetId: string
  assetVersionId: string
  mediaKind: 'image' | 'video' | 'document'
  mimeType: string
  sha256: string
}

interface DerivativePlan {
  kind: AsyncDerivativeKind
  canonicalSpec: string
  outputFormat: DerivativeOutputFormat
  processorFingerprint: string
  parameters: Record<string, string | number>
}

const processorRevisions: Readonly<Record<AsyncDerivativeKind, string>> = {
  video_poster: 'ffmpeg-poster-v1',
  video_transcode: 'ffmpeg-transcode-v1',
  pdf_thumbnail: 'poppler-thumbnail-v1',
  pdf_text: 'poppler-text-v1',
  office_preview: 'libreoffice-pdf-v1',
}

function processorRevision(kind: AsyncDerivativeKind): string {
  return processorRevisions[kind]
}

function milliseconds(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) throw new TypeError('Invalid time value.')
  return Math.round(resolved * 1_000)
}

export function planAsyncDerivative(input: CreateDerivativeRequest): DerivativePlan {
  switch (input.operation) {
    case 'video_poster': {
      const atMs = milliseconds(input.atSeconds, 0)
      const width = input.width ?? 640
      return {
        kind: input.operation,
        canonicalSpec: `video.poster.at_${atMs}.w_${width}`,
        outputFormat: 'jpeg',
        processorFingerprint: processorRevision(input.operation),
        parameters: { atMs, width },
      }
    }
    case 'video_transcode': {
      const startMs = milliseconds(input.startSeconds, 0)
      const durationMs = milliseconds(input.durationSeconds, 60_000 / 1_000)
      return {
        kind: input.operation,
        canonicalSpec: `video.transcode.${input.preset}.start_${startMs}.duration_${durationMs}`,
        outputFormat: input.preset === 'mp4-720p' ? 'mp4' : 'webm',
        processorFingerprint: processorRevision(input.operation),
        parameters: { preset: input.preset, startMs, durationMs },
      }
    }
    case 'pdf_thumbnail': {
      const page = input.page ?? 1
      const maxDimension = input.maxDimension ?? 800
      return {
        kind: input.operation,
        canonicalSpec: `document.thumbnail.page_${page}.max_${maxDimension}`,
        outputFormat: 'png',
        processorFingerprint: processorRevision(input.operation),
        parameters: { page, maxDimension },
      }
    }
    case 'pdf_text':
      return {
        kind: input.operation,
        canonicalSpec: 'document.text',
        outputFormat: 'txt',
        processorFingerprint: processorRevision(input.operation),
        parameters: {},
      }
    case 'office_preview':
      return {
        kind: input.operation,
        canonicalSpec: 'document.office-preview',
        outputFormat: 'pdf',
        processorFingerprint: processorRevision(input.operation),
        parameters: {},
      }
  }
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'Asset not found',
    'asset_not_found',
    'The asset version is unavailable.',
  )
}

function derivativeNotFound(): ApiError {
  return new ApiError(
    404,
    'Derivative not found',
    'derivative_not_found',
    'The derivative does not exist.',
  )
}

export class AsyncDerivativeService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly storage: StorageRuntime,
  ) {}

  create(
    principal: Principal,
    scope: TenantScope,
    publicId: string,
    version: number,
    input: CreateDerivativeRequest,
    requestId: string,
  ): Derivative {
    const createdBy = this.authorize(principal, scope, 'update')
    const source = this.source(scope, publicId, version)
    const plan = planAsyncDerivative(input)
    this.assertCompatible(source, plan.kind)
    const cacheKey = createAsyncDerivativeCacheKey({
      sourceSha256: source.sha256,
      kind: plan.kind,
      canonicalSpec: plan.canonicalSpec,
      outputFormat: plan.outputFormat,
      processorFingerprint: plan.processorFingerprint,
    })
    const now = new Date()

    const record = this.database.client
      .transaction(() => {
        const existing = this.database.db
          .select()
          .from(derivatives)
          .where(
            and(
              eq(derivatives.organizationId, scope.organizationId),
              eq(derivatives.projectId, scope.projectId),
              eq(derivatives.cacheKey, cacheKey),
            ),
          )
          .get()
        if (existing && existing.state !== 'failed') return existing

        const derivativeId = existing?.id ?? uuidv7()
        if (existing) {
          this.database.db
            .update(derivatives)
            .set({ state: 'queued', errorCode: null, completedAt: null, updatedAt: now })
            .where(eq(derivatives.id, existing.id))
            .run()
        } else {
          this.database.db
            .insert(derivatives)
            .values({
              id: derivativeId,
              ...scope,
              assetVersionId: source.assetVersionId,
              cacheKey,
              kind: plan.kind,
              grammarVersion: 1,
              canonicalSpec: plan.canonicalSpec,
              outputFormat: plan.outputFormat,
              processorFingerprint: plan.processorFingerprint,
              state: 'queued',
              createdBy,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }
        this.database.db
          .insert(jobs)
          .values({
            id: uuidv7(),
            ...scope,
            type: 'media.derive',
            payload: {
              derivativeId,
              assetId: source.assetId,
              assetVersionId: source.assetVersionId,
              ...plan.parameters,
            },
            runAfter: now,
            createdBy,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        this.database.db
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            ...scope,
            actorType: principal.type,
            actorId: principal.type === 'user' ? principal.userId : principal.keyId,
            action: 'derivative.requested',
            targetType: 'derivative',
            targetId: derivativeId,
            requestId,
            summary: { assetVersionId: source.assetVersionId, kind: plan.kind },
            createdAt: now,
          })
          .run()
        return this.requireRecord(scope, derivativeId)
      })
      .immediate()
    return this.toContract(record)
  }

  get(principal: Principal, scope: TenantScope, derivativeId: string): Derivative {
    this.authorize(principal, scope, 'read')
    return this.toContract(this.requireRecord(scope, derivativeId))
  }

  async open(
    principal: Principal,
    scope: TenantScope,
    derivativeId: string,
    signal: AbortSignal,
  ): Promise<{ derivative: Derivative; source: Readable }> {
    const derivative = this.get(principal, scope, derivativeId)
    if (derivative.state !== 'ready') {
      throw new ApiError(
        409,
        'Derivative not ready',
        'derivative_not_ready',
        'The derivative has not finished processing.',
      )
    }
    const row = this.database.db
      .select({ key: storageObjects.objectKey, backend: storageObjects.backend })
      .from(derivatives)
      .innerJoin(storageObjects, eq(storageObjects.id, derivatives.storageObjectId))
      .where(and(eq(derivatives.id, derivativeId), eq(storageObjects.state, 'available')))
      .get()
    if (!row || row.backend !== this.storage.backend) {
      throw new ApiError(
        503,
        'Derivative unavailable',
        'storage_backend_unavailable',
        'The derivative storage backend is unavailable.',
      )
    }
    return {
      derivative,
      source: await this.storage.port.open(scope, row.key as StorageObjectKey, { signal }),
    }
  }

  private authorize(
    principal: Principal,
    scope: TenantScope,
    action: 'read' | 'update',
  ): string | undefined {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, action)
      return principal.userId
    }
    const key = this.database.db
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
    if (!key) throw new ApiError(403, 'Access denied', 'access_denied', 'Access is denied.')
    return key.createdBy
  }

  private source(scope: TenantScope, publicId: string, version: number): SourceRecord {
    const row = this.database.db
      .select({
        assetId: assets.id,
        assetVersionId: assetVersions.id,
        mediaKind: assets.mediaKind,
        mimeType: assetVersions.mimeType,
        sha256: assetVersions.sha256,
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
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          eq(assets.publicId, publicId),
          eq(assetVersions.version, version),
          eq(assets.state, 'ready'),
          eq(assetVersions.state, 'ready'),
          isNull(assets.deletedAt),
        ),
      )
      .get()
    if (!row?.mimeType || !row.sha256) throw notFound()
    return { ...row, mimeType: row.mimeType, sha256: row.sha256 }
  }

  private assertCompatible(source: SourceRecord, kind: AsyncDerivativeKind): void {
    const compatible =
      (source.mediaKind === 'video' && (kind === 'video_poster' || kind === 'video_transcode')) ||
      (source.mediaKind === 'document' &&
        ((source.mimeType === 'application/pdf' &&
          (kind === 'pdf_thumbnail' || kind === 'pdf_text')) ||
          (source.mimeType !== 'application/pdf' && kind === 'office_preview')))
    if (!compatible) {
      throw new ApiError(
        415,
        'Unsupported derivative',
        'unsupported_derivative',
        'This derivative operation is not supported for the asset media type.',
      )
    }
  }

  private requireRecord(scope: TenantScope, id: string): DerivativeRecord {
    const record = this.database.db
      .select()
      .from(derivatives)
      .where(
        and(
          eq(derivatives.id, id),
          eq(derivatives.organizationId, scope.organizationId),
          eq(derivatives.projectId, scope.projectId),
          ne(derivatives.kind, 'image'),
        ),
      )
      .get()
    if (!record) throw derivativeNotFound()
    return record
  }

  private toContract(record: DerivativeRecord): Derivative {
    return {
      id: record.id,
      assetVersionId: record.assetVersionId,
      kind: record.kind as AsyncDerivativeKind,
      state: record.state,
      canonicalSpec: record.canonicalSpec,
      outputFormat: record.outputFormat as Derivative['outputFormat'],
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      durationMs: record.durationMs,
      errorCode: record.errorCode,
      contentPath:
        record.state === 'ready'
          ? `/api/v1/organizations/${record.organizationId}/projects/${record.projectId}/derivatives/${record.id}/content`
          : null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    }
  }
}
