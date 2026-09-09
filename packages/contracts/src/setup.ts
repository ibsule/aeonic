export const setupStatusSchema = {
  $id: 'SetupStatus',
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['required', 'complete'] },
  },
} as const

export interface SetupStatus {
  status: 'required' | 'complete'
}

export const setupRequestSchema = {
  $id: 'SetupRequest',
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'email',
    'password',
    'organizationName',
    'organizationSlug',
    'projectName',
    'projectSlug',
  ],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', format: 'email', maxLength: 320 },
    password: { type: 'string', minLength: 12, maxLength: 128 },
    organizationName: { type: 'string', minLength: 1, maxLength: 100 },
    organizationSlug: {
      type: 'string',
      minLength: 2,
      maxLength: 63,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    },
    projectName: { type: 'string', minLength: 1, maxLength: 100 },
    projectSlug: {
      type: 'string',
      minLength: 2,
      maxLength: 63,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    },
  },
} as const

export interface SetupRequest {
  name: string
  email: string
  password: string
  organizationName: string
  organizationSlug: string
  projectName: string
  projectSlug: string
}

export const setupResultSchema = {
  $id: 'SetupResult',
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'organizationId', 'projectId'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
    organizationId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
  },
} as const

export interface SetupResult {
  userId: string
  organizationId: string
  projectId: string
}
