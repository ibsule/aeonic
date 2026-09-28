import { type Asset, assetSchema } from './assets.js'

export const aiIndexStates = ['building', 'evaluating', 'active', 'retired', 'failed'] as const
export type AiIndexState = (typeof aiIndexStates)[number]

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const

export const aiIndexSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'state',
    'provider',
    'embeddingModel',
    'dimensions',
    'pipelineVersion',
    'indexedAssets',
    'createdAt',
    'activatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: aiIndexStates },
    provider: { type: 'string', minLength: 1, maxLength: 64 },
    embeddingModel: { type: 'string', minLength: 1, maxLength: 128 },
    dimensions: { type: 'integer', minimum: 1, maximum: 65_536 },
    pipelineVersion: { type: 'string', minLength: 1, maxLength: 64 },
    indexedAssets: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    activatedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
} as const

export interface AiIndex {
  id: string
  state: AiIndexState
  provider: string
  embeddingModel: string
  dimensions: number
  pipelineVersion: string
  indexedAssets: number
  createdAt: string
  activatedAt: string | null
}

export const semanticSearchSettingsSchema = {
  $id: 'SemanticSearchSettings',
  type: 'object',
  additionalProperties: false,
  required: [
    'deploymentEnabled',
    'providerConfigured',
    'enabled',
    'allowPrivateAssets',
    'monthlyBudgetMicroUsd',
    'monthlySpendMicroUsd',
    'maxAssetsPerRun',
    'concurrency',
    'provider',
    'visionModel',
    'embeddingModel',
    'dimensions',
    'activeIndex',
  ],
  properties: {
    deploymentEnabled: { type: 'boolean' },
    providerConfigured: { type: 'boolean' },
    enabled: { type: 'boolean' },
    allowPrivateAssets: { type: 'boolean' },
    monthlyBudgetMicroUsd: { type: 'integer', minimum: 0 },
    monthlySpendMicroUsd: { type: 'integer', minimum: 0 },
    maxAssetsPerRun: { type: 'integer', minimum: 1, maximum: 10_000 },
    concurrency: { type: 'integer', minimum: 1, maximum: 16 },
    provider: nullableString,
    visionModel: nullableString,
    embeddingModel: nullableString,
    dimensions: { anyOf: [{ type: 'integer', minimum: 1, maximum: 65_536 }, { type: 'null' }] },
    activeIndex: { anyOf: [aiIndexSchema, { type: 'null' }] },
  },
} as const

export interface SemanticSearchSettings {
  deploymentEnabled: boolean
  providerConfigured: boolean
  enabled: boolean
  allowPrivateAssets: boolean
  monthlyBudgetMicroUsd: number
  monthlySpendMicroUsd: number
  maxAssetsPerRun: number
  concurrency: number
  provider: string | null
  visionModel: string | null
  embeddingModel: string | null
  dimensions: number | null
  activeIndex: AiIndex | null
}

export const updateSemanticSearchSettingsRequestSchema = {
  $id: 'UpdateSemanticSearchSettingsRequest',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    enabled: { type: 'boolean' },
    allowPrivateAssets: { type: 'boolean' },
    monthlyBudgetMicroUsd: { type: 'integer', minimum: 0, maximum: 1_000_000_000_000 },
    maxAssetsPerRun: { type: 'integer', minimum: 1, maximum: 10_000 },
    concurrency: { type: 'integer', minimum: 1, maximum: 16 },
  },
} as const

export interface UpdateSemanticSearchSettingsRequest {
  enabled?: boolean
  allowPrivateAssets?: boolean
  monthlyBudgetMicroUsd?: number
  maxAssetsPerRun?: number
  concurrency?: number
}

export const updateAssetAiExclusionRequestSchema = {
  $id: 'UpdateAssetAiExclusionRequest',
  type: 'object',
  additionalProperties: false,
  required: ['excluded'],
  properties: { excluded: { type: 'boolean' } },
} as const

export interface UpdateAssetAiExclusionRequest {
  excluded: boolean
}

export const startSemanticReindexRequestSchema = {
  $id: 'StartSemanticReindexRequest',
  type: 'object',
  additionalProperties: false,
  properties: {
    maximumAssets: { type: 'integer', minimum: 1, maximum: 10_000 },
  },
} as const

export interface StartSemanticReindexRequest {
  maximumAssets?: number
}

export const semanticSearchReasons = [
  'filename',
  'folder',
  'metadata',
  'extracted_text',
  'ai_caption',
  'semantic_similarity',
] as const
export type SemanticSearchReason = (typeof semanticSearchReasons)[number]

export const semanticSearchHitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['asset', 'score', 'lexicalRank', 'semanticRank', 'reasons', 'caption'],
  properties: {
    asset: assetSchema,
    score: { type: 'number', minimum: 0 },
    lexicalRank: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    semanticRank: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    reasons: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', enum: semanticSearchReasons },
    },
    caption: nullableString,
  },
} as const

export interface SemanticSearchHit {
  asset: Asset
  score: number
  lexicalRank: number | null
  semanticRank: number | null
  reasons: SemanticSearchReason[]
  caption: string | null
}

export const semanticSearchResponseSchema = {
  $id: 'SemanticSearchResponse',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'mode', 'degradedReason', 'index'],
  properties: {
    items: { type: 'array', maxItems: 100, items: semanticSearchHitSchema },
    mode: { type: 'string', enum: ['lexical', 'hybrid'] },
    degradedReason: nullableString,
    index: { anyOf: [aiIndexSchema, { type: 'null' }] },
  },
} as const

export interface SemanticSearchResponse {
  items: SemanticSearchHit[]
  mode: 'lexical' | 'hybrid'
  degradedReason: string | null
  index: AiIndex | null
}

export const semanticEvaluationSchema = {
  $id: 'SemanticEvaluation',
  type: 'object',
  additionalProperties: false,
  required: [
    'indexId',
    'queryCount',
    'recallAt10',
    'ndcgAt10',
    'tenantFilterFailures',
    'approved',
    'evaluatedAt',
  ],
  properties: {
    indexId: { type: 'string', format: 'uuid' },
    queryCount: { type: 'integer', minimum: 1 },
    recallAt10: { type: 'number', minimum: 0, maximum: 1 },
    ndcgAt10: { type: 'number', minimum: 0, maximum: 1 },
    tenantFilterFailures: { type: 'integer', minimum: 0 },
    approved: { type: 'boolean' },
    evaluatedAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface SemanticEvaluation {
  indexId: string
  queryCount: number
  recallAt10: number
  ndcgAt10: number
  tenantFilterFailures: number
  approved: boolean
  evaluatedAt: string
}
