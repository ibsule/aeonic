export const mediaKinds = ['image', 'video', 'document'] as const
export type MediaKind = (typeof mediaKinds)[number]

export const uploadQuerySchema = {
  $id: 'UploadQuery',
  type: 'object',
  additionalProperties: false,
  required: ['filename'],
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 255 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    folder: { type: 'string', maxLength: 512 },
    visibility: { type: 'string', enum: ['private', 'public'] },
  },
} as const

export interface UploadQuery {
  filename: string
  name?: string
  folder?: string
  visibility?: 'private' | 'public'
}

export const simpleUploadResultSchema = {
  $id: 'SimpleUploadResult',
  type: 'object',
  additionalProperties: false,
  required: [
    'uploadId',
    'assetId',
    'assetVersionId',
    'publicId',
    'name',
    'folder',
    'visibility',
    'mediaKind',
    'state',
    'mimeType',
    'sizeBytes',
    'sha256',
    'createdAt',
  ],
  properties: {
    uploadId: { type: 'string', format: 'uuid' },
    assetId: { type: 'string', format: 'uuid' },
    assetVersionId: { type: 'string', format: 'uuid' },
    publicId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    folder: { type: 'string', maxLength: 512 },
    visibility: { type: 'string', enum: ['private', 'public'] },
    mediaKind: { type: 'string', enum: mediaKinds },
    state: { type: 'string', const: 'processing' },
    mimeType: { type: 'string', minLength: 1 },
    sizeBytes: { type: 'integer', minimum: 1 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface SimpleUploadResult {
  uploadId: string
  assetId: string
  assetVersionId: string
  publicId: string
  name: string
  folder: string
  visibility: 'private' | 'public'
  mediaKind: MediaKind
  state: 'processing'
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: string
}
