export const assetStates = [
  'uploading',
  'validating',
  'processing',
  'ready',
  'replacing',
  'deleting',
  'deleted',
  'rejected',
  'failed',
] as const

export type AssetState = (typeof assetStates)[number]
export type AssetVisibility = 'private' | 'public'

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const

export const assetVersionSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'state',
    'mimeType',
    'sizeBytes',
    'sha256',
    'width',
    'height',
    'durationMs',
    'metadata',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    version: { type: 'integer', minimum: 1 },
    state: {
      type: 'string',
      enum: ['uploading', 'validating', 'processing', 'ready', 'rejected', 'failed'],
    },
    mimeType: nullableString,
    sizeBytes: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    sha256: {
      anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }],
    },
    width: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    height: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    durationMs: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    metadata: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface AssetVersionSummary {
  id: string
  version: number
  state: 'uploading' | 'validating' | 'processing' | 'ready' | 'rejected' | 'failed'
  mimeType: string | null
  sizeBytes: number | null
  sha256: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export const assetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'publicId',
    'name',
    'folder',
    'mediaKind',
    'visibility',
    'state',
    'currentVersion',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    publicId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1, maxLength: 255 },
    folder: { type: 'string', maxLength: 255 },
    mediaKind: { type: 'string', enum: ['image', 'video', 'document'] },
    visibility: { type: 'string', enum: ['private', 'public'] },
    state: { type: 'string', enum: assetStates },
    currentVersion: { type: 'integer', minimum: 0 },
    version: { anyOf: [assetVersionSummarySchema, { type: 'null' }] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface Asset {
  id: string
  publicId: string
  name: string
  folder: string
  mediaKind: 'image' | 'video' | 'document'
  visibility: AssetVisibility
  state: AssetState
  currentVersion: number
  version: AssetVersionSummary | null
  createdAt: string
  updatedAt: string
}

export const assetListSchema = {
  $id: 'AssetList',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', maxItems: 100, items: assetSchema },
    nextCursor: nullableString,
  },
} as const

export interface AssetList {
  items: Asset[]
  nextCursor: string | null
}

export const updateAssetRequestSchema = {
  $id: 'UpdateAssetRequest',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    folder: { type: 'string', maxLength: 255 },
    visibility: { type: 'string', enum: ['private', 'public'] },
  },
} as const

export interface UpdateAssetRequest {
  name?: string
  folder?: string
  visibility?: AssetVisibility
}
