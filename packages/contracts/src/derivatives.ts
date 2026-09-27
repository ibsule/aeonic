export const derivativeKinds = [
  'video_poster',
  'video_transcode',
  'pdf_thumbnail',
  'pdf_text',
  'office_preview',
] as const

export type AsyncDerivativeKind = (typeof derivativeKinds)[number]
export type VideoDerivativePreset = 'mp4-720p' | 'webm-720p'

export type CreateDerivativeRequest =
  | { operation: 'video_poster'; atSeconds?: number; width?: number }
  | {
      operation: 'video_transcode'
      preset: VideoDerivativePreset
      startSeconds?: number
      durationSeconds?: number
    }
  | { operation: 'pdf_thumbnail'; page?: number; maxDimension?: number }
  | { operation: 'pdf_text' }
  | { operation: 'office_preview' }

const operation = <T extends AsyncDerivativeKind>(value: T) => ({
  type: 'string' as const,
  const: value,
})

export const createDerivativeRequestSchema = {
  $id: 'CreateDerivativeRequest',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: operation('video_poster'),
        atSeconds: { type: 'number', minimum: 0, maximum: 86_400 },
        width: { type: 'integer', minimum: 1, maximum: 1_920 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'preset'],
      properties: {
        operation: operation('video_transcode'),
        preset: { type: 'string', enum: ['mp4-720p', 'webm-720p'] },
        startSeconds: { type: 'number', minimum: 0, maximum: 86_400 },
        durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 60 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: operation('pdf_thumbnail'),
        page: { type: 'integer', minimum: 1, maximum: 10_000 },
        maxDimension: { type: 'integer', minimum: 1, maximum: 4_096 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: operation('pdf_text') },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: operation('office_preview') },
    },
  ],
} as const

export type DerivativeState = 'queued' | 'generating' | 'ready' | 'failed'

export interface Derivative {
  id: string
  assetVersionId: string
  kind: AsyncDerivativeKind
  state: DerivativeState
  canonicalSpec: string
  outputFormat: 'jpeg' | 'png' | 'mp4' | 'webm' | 'pdf' | 'txt'
  sizeBytes: number | null
  sha256: string | null
  mimeType: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  errorCode: string | null
  contentPath: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export const derivativeSchema = {
  $id: 'Derivative',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'assetVersionId',
    'kind',
    'state',
    'canonicalSpec',
    'outputFormat',
    'sizeBytes',
    'sha256',
    'mimeType',
    'width',
    'height',
    'durationMs',
    'errorCode',
    'contentPath',
    'createdAt',
    'updatedAt',
    'completedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    assetVersionId: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: derivativeKinds },
    state: { type: 'string', enum: ['queued', 'generating', 'ready', 'failed'] },
    canonicalSpec: { type: 'string', minLength: 1, maxLength: 256 },
    outputFormat: { type: 'string', enum: ['jpeg', 'png', 'mp4', 'webm', 'pdf', 'txt'] },
    sizeBytes: { type: ['integer', 'null'], minimum: 0 },
    sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
    mimeType: { type: ['string', 'null'], minLength: 1 },
    width: { type: ['integer', 'null'], minimum: 1 },
    height: { type: ['integer', 'null'], minimum: 1 },
    durationMs: { type: ['integer', 'null'], minimum: 0 },
    errorCode: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_]{0,63}$' },
    contentPath: { type: ['string', 'null'], minLength: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const
