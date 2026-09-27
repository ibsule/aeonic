import type {
  AiIndex,
  Asset,
  SemanticSearchReason,
  SemanticSearchResponse,
  SemanticSearchSettings,
  StartSemanticReindexRequest,
  UpdateSemanticSearchSettingsRequest,
} from '@aeonic/contracts'
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import {
  aiAssetExclusions,
  aiIndexRecords,
  aiIndexes,
  aiProjectSettings,
  aiUsageLedger,
  assets,
  assetVersions,
  auditEvents,
  jobs,
} from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import type { EmbeddingProvider, ProviderUsage, VectorIndex } from './contracts.js'

interface LexicalRow {
  asset_id: string
  name: string
  folder: string
  metadata_text: string
  extracted_text: string
  caption: string
}

const assetSelection = {
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

type SelectedAsset = {
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

function toAsset(row: SelectedAsset): Asset {
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

function toIndex(row: typeof aiIndexes.$inferSelect): AiIndex {
  return {
    id: row.id,
    state: row.state,
    provider: row.provider,
    embeddingModel: row.embeddingModel,
    dimensions: row.dimensions,
    pipelineVersion: row.pipelineVersion,
    indexedAssets: row.indexedAssets,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
  }
}

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ]
    .filter((term) => term.length > 0)
    .slice(0, 16)
}

function lexicalReasons(row: LexicalRow, terms: readonly string[]): SemanticSearchReason[] {
  const fields: Array<[SemanticSearchReason, string]> = [
    ['filename', row.name],
    ['folder', row.folder],
    ['metadata', row.metadata_text],
    ['extracted_text', row.extracted_text],
    ['ai_caption', row.caption],
  ]
  const reasons = fields
    .filter(([, value]) => terms.some((term) => value.toLocaleLowerCase().includes(term)))
    .map(([reason]) => reason)
  return reasons.length > 0 ? reasons : ['metadata']
}

function principalActor(principal: Principal): { actorType: 'user' | 'api_key'; actorId: string } {
  return principal.type === 'user'
    ? { actorType: 'user', actorId: principal.userId }
    : { actorType: 'api_key', actorId: principal.keyId }
}

export class SemanticSearchService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly config: AppConfig,
    private readonly embeddings?: EmbeddingProvider,
    private readonly vectors?: VectorIndex,
  ) {}

  settings(principal: Principal, scope: TenantScope): SemanticSearchSettings {
    this.authorizeRead(principal, scope)
    const stored = this.database.db
      .select()
      .from(aiProjectSettings)
      .where(
        and(
          eq(aiProjectSettings.organizationId, scope.organizationId),
          eq(aiProjectSettings.projectId, scope.projectId),
        ),
      )
      .get()
    const active = this.activeIndex(scope)
    return {
      deploymentEnabled: this.config.aiEnabled,
      providerConfigured: Boolean(this.embeddings && this.vectors),
      enabled: stored?.enabled ?? false,
      allowPrivateAssets: stored?.allowPrivateAssets ?? false,
      monthlyBudgetMicroUsd: stored?.monthlyBudgetMicroUsd ?? 0,
      monthlySpendMicroUsd: this.monthlySpend(scope),
      maxAssetsPerRun: stored?.maxAssetsPerRun ?? 100,
      concurrency: stored?.concurrency ?? 1,
      provider: this.config.aiEnabled ? this.config.aiProvider : null,
      visionModel: this.config.aiVisionModel ?? null,
      embeddingModel: this.config.aiEmbeddingModel ?? null,
      dimensions: this.config.aiEnabled ? this.config.aiEmbeddingDimensions : null,
      activeIndex: active ? toIndex(active) : null,
    }
  }

  updateSettings(
    principal: Principal,
    scope: TenantScope,
    input: UpdateSemanticSearchSettingsRequest,
    requestId: string,
  ): SemanticSearchSettings {
    const userId = this.authorizeManage(principal, scope)
    const current = this.settings(principal, scope)
    const enabled = input.enabled ?? current.enabled
    const monthlyBudgetMicroUsd = input.monthlyBudgetMicroUsd ?? current.monthlyBudgetMicroUsd
    if (enabled && (!this.config.aiEnabled || !this.embeddings || !this.vectors)) {
      throw new ApiError(
        409,
        'AI deployment unavailable',
        'ai_deployment_unavailable',
        'Configure and start the optional AI profile before enabling semantic indexing.',
      )
    }
    if (
      enabled &&
      monthlyBudgetMicroUsd === 0 &&
      (this.config.aiInputMicroUsdPerMillionUnits > 0 ||
        this.config.aiOutputMicroUsdPerMillionUnits > 0)
    ) {
      throw new ApiError(
        409,
        'AI budget required',
        'ai_budget_required',
        'Set a positive monthly budget before enabling a priced provider.',
      )
    }
    const now = new Date()
    this.database.db
      .insert(aiProjectSettings)
      .values({
        ...scope,
        enabled,
        allowPrivateAssets: input.allowPrivateAssets ?? current.allowPrivateAssets,
        monthlyBudgetMicroUsd,
        maxAssetsPerRun: input.maxAssetsPerRun ?? current.maxAssetsPerRun,
        concurrency: input.concurrency ?? current.concurrency,
        version: 1,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [aiProjectSettings.organizationId, aiProjectSettings.projectId],
        set: {
          enabled,
          allowPrivateAssets: input.allowPrivateAssets ?? current.allowPrivateAssets,
          monthlyBudgetMicroUsd,
          maxAssetsPerRun: input.maxAssetsPerRun ?? current.maxAssetsPerRun,
          concurrency: input.concurrency ?? current.concurrency,
          version: sql`${aiProjectSettings.version} + 1`,
          updatedBy: userId,
          updatedAt: now,
        },
      })
      .run()
    this.audit(principal, scope, 'ai.settings_updated', 'project', scope.projectId, requestId, {
      enabled,
      allowPrivateAssets: input.allowPrivateAssets ?? current.allowPrivateAssets,
      monthlyBudgetMicroUsd,
      maxAssetsPerRun: input.maxAssetsPerRun ?? current.maxAssetsPerRun,
      concurrency: input.concurrency ?? current.concurrency,
    })
    return this.settings(principal, scope)
  }

  startReindex(
    principal: Principal,
    scope: TenantScope,
    input: StartSemanticReindexRequest,
    requestId: string,
  ): AiIndex {
    const userId = this.authorizeManage(principal, scope)
    const settings = this.settings(principal, scope)
    if (!settings.enabled || !this.embeddings || !this.vectors) {
      throw new ApiError(
        409,
        'Semantic search disabled',
        'semantic_search_disabled',
        'Enable semantic search for the project before starting a reindex.',
      )
    }
    if (this.budgetExhausted(settings)) {
      throw new ApiError(
        409,
        'AI budget exhausted',
        'ai_budget_exhausted',
        'The project monthly AI budget has been exhausted.',
      )
    }
    const existing = this.database.db
      .select({ id: aiIndexes.id })
      .from(aiIndexes)
      .where(
        and(
          eq(aiIndexes.organizationId, scope.organizationId),
          eq(aiIndexes.projectId, scope.projectId),
          inArray(aiIndexes.state, ['building', 'evaluating']),
        ),
      )
      .get()
    if (existing) {
      throw new ApiError(
        409,
        'Reindex already active',
        'reindex_already_active',
        'Wait for the current candidate index to finish.',
      )
    }
    if (!this.config.aiVisionModel || !this.config.aiEmbeddingModel) {
      throw new Error('Enabled AI configuration is missing model identifiers.')
    }
    const id = uuidv7()
    const now = new Date()
    const maximumAssets = Math.min(
      input.maximumAssets ?? settings.maxAssetsPerRun,
      settings.maxAssetsPerRun,
    )
    const collection = `aeonic_${id.replaceAll('-', '')}`
    this.database.db.transaction((transaction) => {
      transaction
        .insert(aiIndexes)
        .values({
          id,
          ...scope,
          state: 'building',
          provider: this.config.aiProvider,
          visionModel: this.config.aiVisionModel as string,
          embeddingModel: this.config.aiEmbeddingModel as string,
          dimensions: this.config.aiEmbeddingDimensions,
          pipelineVersion: this.config.aiPipelineVersion,
          promptVersion: 'media-caption-v1',
          collectionName: collection,
          indexedAssets: 0,
          createdBy: userId,
          createdAt: now,
        })
        .run()
      transaction
        .insert(jobs)
        .values({
          id: uuidv7(),
          ...scope,
          type: 'ai.reindex',
          state: 'queued',
          payload: { indexId: id, maximumAssets },
          progress: 0,
          attempts: 0,
          maxAttempts: 3,
          runAfter: now,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    this.audit(principal, scope, 'ai.reindex_started', 'ai_index', id, requestId, {
      maximumAssets,
      provider: this.config.aiProvider,
      embeddingModel: this.config.aiEmbeddingModel,
      dimensions: this.config.aiEmbeddingDimensions,
    })
    const created = this.database.db.select().from(aiIndexes).where(eq(aiIndexes.id, id)).get()
    if (!created) throw new Error('The candidate AI index was not persisted.')
    return toIndex(created)
  }

  setAssetExclusion(
    principal: Principal,
    scope: TenantScope,
    publicId: string,
    excluded: boolean,
    requestId: string,
  ): void {
    const userId = this.authorizeManage(principal, scope)
    const asset = this.findAsset(scope, publicId)
    const now = new Date()
    this.database.db.transaction((transaction) => {
      if (excluded) {
        transaction
          .insert(aiAssetExclusions)
          .values({ ...scope, assetId: asset.id, createdBy: userId, createdAt: now })
          .onConflictDoNothing()
          .run()
        transaction
          .delete(aiIndexRecords)
          .where(
            and(
              eq(aiIndexRecords.organizationId, scope.organizationId),
              eq(aiIndexRecords.projectId, scope.projectId),
              eq(aiIndexRecords.assetId, asset.id),
            ),
          )
          .run()
        for (const index of transaction
          .select({ id: aiIndexes.id, collectionName: aiIndexes.collectionName })
          .from(aiIndexes)
          .where(
            and(
              eq(aiIndexes.organizationId, scope.organizationId),
              eq(aiIndexes.projectId, scope.projectId),
              inArray(aiIndexes.state, ['building', 'evaluating', 'active']),
            ),
          )
          .all()) {
          transaction
            .insert(jobs)
            .values({
              id: uuidv7(),
              ...scope,
              type: 'ai.delete_asset',
              state: 'queued',
              payload: {
                indexId: index.id,
                collectionName: index.collectionName,
                assetId: asset.id,
              },
              progress: 0,
              attempts: 0,
              maxAttempts: 3,
              runAfter: now,
              createdBy: userId,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }
      } else {
        transaction
          .delete(aiAssetExclusions)
          .where(
            and(
              eq(aiAssetExclusions.organizationId, scope.organizationId),
              eq(aiAssetExclusions.projectId, scope.projectId),
              eq(aiAssetExclusions.assetId, asset.id),
            ),
          )
          .run()
      }
    })
    this.audit(principal, scope, 'ai.asset_exclusion_updated', 'asset', asset.id, requestId, {
      excluded,
    })
  }

  deleteIndex(principal: Principal, scope: TenantScope, indexId: string, requestId: string): void {
    const userId = this.authorizeManage(principal, scope)
    if (!isUuid(indexId)) throw this.indexNotFound()
    const index = this.database.db
      .select()
      .from(aiIndexes)
      .where(
        and(
          eq(aiIndexes.id, indexId),
          eq(aiIndexes.organizationId, scope.organizationId),
          eq(aiIndexes.projectId, scope.projectId),
        ),
      )
      .get()
    if (!index) throw this.indexNotFound()
    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction.delete(aiIndexes).where(eq(aiIndexes.id, index.id)).run()
      transaction
        .insert(jobs)
        .values({
          id: uuidv7(),
          ...scope,
          type: 'ai.delete_index',
          state: 'queued',
          payload: { collectionName: index.collectionName },
          progress: 0,
          attempts: 0,
          maxAttempts: 3,
          runAfter: now,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    this.audit(principal, scope, 'ai.index_deleted', 'ai_index', index.id, requestId, {
      provider: index.provider,
      embeddingModel: index.embeddingModel,
    })
  }

  async search(
    principal: Principal,
    scope: TenantScope,
    query: string,
    limit: number,
  ): Promise<SemanticSearchResponse> {
    this.authorizeRead(principal, scope)
    const terms = searchTerms(query)
    if (terms.length === 0 || query.length > 500) {
      throw new ApiError(
        400,
        'Invalid search query',
        'invalid_search_query',
        'Search queries must contain searchable text and no more than 500 characters.',
      )
    }
    this.refreshLexicalDocuments(scope)
    const ftsQuery = terms.map((term) => `${term}*`).join(' AND ')
    const lexical = this.database.client
      .prepare(
        `select d.asset_id, d.name, d.folder, d.metadata_text, d.extracted_text, d.caption
           from asset_search_fts
           join asset_search_documents d on d.id = asset_search_fts.rowid
          where asset_search_fts match ?
            and d.organization_id = ?
            and d.project_id = ?
          order by bm25(asset_search_fts, 8.0, 4.0, 2.0, 1.0, 3.0), d.asset_id
          limit ?`,
      )
      .all(
        ftsQuery,
        scope.organizationId,
        scope.projectId,
        Math.min(limit * 3, 100),
      ) as LexicalRow[]

    const settings = this.settings(principal, scope)
    const active = this.activeIndex(scope)
    let semantic: Array<{ assetId: string; rank: number }> = []
    let degradedReason: string | null = null
    if (settings.enabled && active && this.embeddings && this.vectors) {
      if (this.budgetExhausted(settings)) {
        degradedReason = 'ai_budget_exhausted'
      } else {
        try {
          const embedded = await this.embeddings.embedText({ texts: [query] })
          this.recordUsage(scope, active.id, this.embeddings.model, 'embedding', embedded.usage)
          const candidates = await this.vectors.search(
            active.collectionName,
            embedded.vectors[0] ?? [],
            scope,
            Math.min(limit * 3, 100),
          )
          const allowed = this.revalidateVectorCandidates(
            scope,
            active.id,
            candidates.map((candidate) => candidate.assetId),
          )
          semantic = candidates
            .filter((candidate) => allowed.has(candidate.assetId))
            .map((candidate, index) => ({ assetId: candidate.assetId, rank: index + 1 }))
        } catch {
          degradedReason = 'semantic_dependency_unavailable'
        }
      }
    } else if (settings.enabled) {
      degradedReason = 'semantic_index_unavailable'
    }

    const fused = new Map<
      string,
      {
        score: number
        lexicalRank: number | null
        semanticRank: number | null
        reasons: Set<SemanticSearchReason>
        caption: string | null
      }
    >()
    lexical.forEach((row, index) => {
      fused.set(row.asset_id, {
        score: 1 / (60 + index + 1),
        lexicalRank: index + 1,
        semanticRank: null,
        reasons: new Set(lexicalReasons(row, terms)),
        caption: row.caption || null,
      })
    })
    semantic.forEach((row) => {
      const current = fused.get(row.assetId) ?? {
        score: 0,
        lexicalRank: null,
        semanticRank: null,
        reasons: new Set<SemanticSearchReason>(),
        caption: null,
      }
      current.score += 1 / (60 + row.rank)
      current.semanticRank = row.rank
      current.reasons.add('semantic_similarity')
      fused.set(row.assetId, current)
    })
    const ranked = [...fused.entries()]
      .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
      .slice(0, limit)
    const assetMap = this.loadAssets(
      scope,
      ranked.map(([assetId]) => assetId),
    )
    return {
      items: ranked.flatMap(([assetId, ranking]) => {
        const asset = assetMap.get(assetId)
        return asset
          ? [
              {
                asset,
                score: ranking.score,
                lexicalRank: ranking.lexicalRank,
                semanticRank: ranking.semanticRank,
                reasons: [...ranking.reasons],
                caption: ranking.caption,
              },
            ]
          : []
      }),
      mode: semantic.length > 0 ? 'hybrid' : 'lexical',
      degradedReason,
      index: active ? toIndex(active) : null,
    }
  }

  private refreshLexicalDocuments(scope: TenantScope): void {
    this.database.client
      .prepare(
        `insert into asset_search_documents (
           organization_id, project_id, asset_id, public_id, name, folder,
           metadata_text, extracted_text, caption, updated_at
         )
         select a.organization_id, a.project_id, a.id, a.public_id, a.name, a.folder,
           coalesce(cast(v.metadata as text), ''),
           coalesce((
             select group_concat(r.source_text, ' ')
               from ai_index_records r
               join ai_indexes i on i.id = r.index_id and i.state = 'active'
              where r.asset_id = a.id and r.asset_version_id = v.id
           ), ''),
           coalesce((
             select group_concat(r.caption, ' ')
               from ai_index_records r
               join ai_indexes i on i.id = r.index_id and i.state = 'active'
              where r.asset_id = a.id and r.asset_version_id = v.id
           ), ''),
           a.updated_at
         from assets a
         left join asset_versions v on v.asset_id = a.id and v.version = a.current_version
         where a.organization_id = ? and a.project_id = ? and a.deleted_at is null
         on conflict(organization_id, project_id, asset_id) do update set
           public_id = excluded.public_id,
           name = excluded.name,
           folder = excluded.folder,
           metadata_text = excluded.metadata_text,
           extracted_text = excluded.extracted_text,
           caption = excluded.caption,
           updated_at = excluded.updated_at`,
      )
      .run(scope.organizationId, scope.projectId)
    this.database.client
      .prepare(
        `delete from asset_search_documents
          where organization_id = ? and project_id = ?
            and not exists (
              select 1 from assets a
               where a.id = asset_search_documents.asset_id and a.deleted_at is null
            )`,
      )
      .run(scope.organizationId, scope.projectId)
  }

  private revalidateVectorCandidates(
    scope: TenantScope,
    indexId: string,
    assetIds: readonly string[],
  ): Set<string> {
    if (assetIds.length === 0) return new Set()
    const rows = this.database.db
      .select({ assetId: assets.id })
      .from(assets)
      .innerJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, assets.currentVersion)),
      )
      .innerJoin(
        aiIndexRecords,
        and(
          eq(aiIndexRecords.assetId, assets.id),
          eq(aiIndexRecords.assetVersionId, assetVersions.id),
          eq(aiIndexRecords.indexId, indexId),
        ),
      )
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          isNull(assets.deletedAt),
          inArray(assets.id, [...new Set(assetIds)]),
        ),
      )
      .all()
    return new Set(rows.map((row) => row.assetId))
  }

  private loadAssets(scope: TenantScope, assetIds: readonly string[]): Map<string, Asset> {
    if (assetIds.length === 0) return new Map()
    const rows = this.database.db
      .select(assetSelection)
      .from(assets)
      .leftJoin(
        assetVersions,
        and(eq(assetVersions.assetId, assets.id), eq(assetVersions.version, assets.currentVersion)),
      )
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          isNull(assets.deletedAt),
          inArray(assets.id, [...new Set(assetIds)]),
        ),
      )
      .all() as SelectedAsset[]
    return new Map(rows.map((row) => [row.id, toAsset(row)]))
  }

  private findAsset(scope: TenantScope, publicId: string): { id: string } {
    if (!isUuid(publicId)) throw this.assetNotFound()
    const asset = this.database.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
          eq(assets.publicId, publicId),
          isNull(assets.deletedAt),
        ),
      )
      .get()
    if (!asset) throw this.assetNotFound()
    return asset
  }

  private monthlySpend(scope: TenantScope): number {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return (
      this.database.db
        .select({ value: sql<number>`coalesce(sum(${aiUsageLedger.costMicroUsd}), 0)` })
        .from(aiUsageLedger)
        .where(
          and(
            eq(aiUsageLedger.organizationId, scope.organizationId),
            eq(aiUsageLedger.projectId, scope.projectId),
            gte(aiUsageLedger.occurredAt, start),
          ),
        )
        .get()?.value ?? 0
    )
  }

  private budgetExhausted(settings: SemanticSearchSettings): boolean {
    if (
      settings.monthlyBudgetMicroUsd === 0 &&
      this.config.aiInputMicroUsdPerMillionUnits === 0 &&
      this.config.aiOutputMicroUsdPerMillionUnits === 0
    ) {
      return false
    }
    return settings.monthlySpendMicroUsd >= settings.monthlyBudgetMicroUsd
  }

  private recordUsage(
    scope: TenantScope,
    indexId: string | null,
    model: string,
    operation: 'caption' | 'embedding',
    usage: ProviderUsage,
  ): void {
    const costMicroUsd = Math.ceil(
      (usage.inputUnits * this.config.aiInputMicroUsdPerMillionUnits +
        usage.outputUnits * this.config.aiOutputMicroUsdPerMillionUnits) /
        1_000_000,
    )
    this.database.db
      .insert(aiUsageLedger)
      .values({
        id: uuidv7(),
        ...scope,
        indexId,
        provider: this.config.aiProvider,
        model,
        operation,
        inputUnits: usage.inputUnits,
        outputUnits: usage.outputUnits,
        costMicroUsd,
        occurredAt: new Date(),
      })
      .run()
  }

  private activeIndex(scope: TenantScope): typeof aiIndexes.$inferSelect | undefined {
    return this.database.db
      .select()
      .from(aiIndexes)
      .where(
        and(
          eq(aiIndexes.organizationId, scope.organizationId),
          eq(aiIndexes.projectId, scope.projectId),
          eq(aiIndexes.state, 'active'),
        ),
      )
      .orderBy(desc(aiIndexes.activatedAt))
      .get()
  }

  private authorizeRead(principal: Principal, scope: TenantScope): void {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, 'read')
      return
    }
    if (
      principal.organizationId !== scope.organizationId ||
      principal.projectId !== scope.projectId
    ) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'You cannot search this project.')
    }
  }

  private authorizeManage(principal: Principal, scope: TenantScope): string {
    if (principal.type !== 'user') {
      throw new ApiError(
        403,
        'Access denied',
        'access_denied',
        'Only an owner or administrator can manage semantic search.',
      )
    }
    this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, 'update')
    return principal.userId
  }

  private audit(
    principal: Principal,
    scope: TenantScope,
    action: string,
    targetType: string,
    targetId: string,
    requestId: string,
    summary: Record<string, unknown>,
  ): void {
    this.database.db
      .insert(auditEvents)
      .values({
        id: uuidv7(),
        ...scope,
        ...principalActor(principal),
        action,
        targetType,
        targetId,
        requestId,
        summary,
        createdAt: new Date(),
      })
      .run()
  }

  private assetNotFound(): ApiError {
    return new ApiError(404, 'Asset not found', 'asset_not_found', 'The asset does not exist.')
  }

  private indexNotFound(): ApiError {
    return new ApiError(
      404,
      'AI index not found',
      'ai_index_not_found',
      'The index does not exist.',
    )
  }
}
