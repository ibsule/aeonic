const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const

export const auditEventSchema = {
  $id: 'AuditEvent',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organizationId',
    'projectId',
    'actorType',
    'actorId',
    'action',
    'targetType',
    'targetId',
    'requestId',
    'summary',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    organizationId: nullableString,
    projectId: nullableString,
    actorType: { enum: ['user', 'api_key', 'system'] },
    actorId: nullableString,
    action: { type: 'string', minLength: 1 },
    targetType: { type: 'string', minLength: 1 },
    targetId: { type: 'string', minLength: 1 },
    requestId: { type: 'string', minLength: 1 },
    summary: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface AuditEvent {
  id: string
  organizationId: string | null
  projectId: string | null
  actorType: 'user' | 'api_key' | 'system'
  actorId: string | null
  action: string
  targetType: string
  targetId: string
  requestId: string
  summary: Record<string, unknown> | null
  createdAt: string
}

export const auditEventListSchema = {
  $id: 'AuditEventList',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', maxItems: 100, items: auditEventSchema },
    nextCursor: nullableString,
  },
} as const

export interface AuditEventList {
  items: AuditEvent[]
  nextCursor: string | null
}
