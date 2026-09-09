export const apiKeyScopes = [
  'projects:read',
  'assets:read',
  'assets:write',
  'assets:delete',
  'jobs:read',
] as const

export type ApiKeyScope = (typeof apiKeyScopes)[number]

const apiKeyProperties = {
  id: { type: 'string', format: 'uuid' },
  projectId: { type: 'string', format: 'uuid' },
  name: { type: 'string', minLength: 1, maxLength: 100 },
  prefix: { type: ['string', 'null'] },
  scopes: {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { type: 'string', enum: apiKeyScopes },
  },
  expiresAt: { type: ['string', 'null'], format: 'date-time' },
  createdAt: { type: 'string', format: 'date-time' },
  revokedAt: { type: ['string', 'null'], format: 'date-time' },
} as const

export const apiKeySchema = {
  $id: 'ApiKey',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'projectId', 'name', 'prefix', 'scopes', 'expiresAt', 'createdAt', 'revokedAt'],
  properties: apiKeyProperties,
} as const

export interface ApiKey {
  id: string
  projectId: string
  name: string
  prefix: string | null
  scopes: ApiKeyScope[]
  expiresAt: string | null
  createdAt: string
  revokedAt: string | null
}

export const createdApiKeySchema = {
  $id: 'CreatedApiKey',
  type: 'object',
  additionalProperties: false,
  required: [...apiKeySchema.required, 'secret'],
  properties: {
    ...apiKeyProperties,
    secret: { type: 'string', minLength: 20 },
  },
} as const

export interface CreatedApiKey extends ApiKey {
  secret: string
}

export const apiKeyListSchema = {
  $id: 'ApiKeyList',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', maxItems: 100, items: apiKeySchema },
  },
} as const

export interface ApiKeyList {
  items: ApiKey[]
}

export const createApiKeyRequestSchema = {
  $id: 'CreateApiKeyRequest',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'scopes'],
  properties: {
    name: apiKeyProperties.name,
    scopes: apiKeyProperties.scopes,
    expiresInSeconds: { type: 'integer', minimum: 3_600, maximum: 31_536_000 },
  },
} as const

export interface CreateApiKeyRequest {
  name: string
  scopes: ApiKeyScope[]
  expiresInSeconds?: number
}
