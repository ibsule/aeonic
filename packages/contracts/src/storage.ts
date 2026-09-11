const storageFailureSummaryBody = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'code', 'count'],
  properties: {
    source: { type: 'string', enum: ['object', 'upload'] },
    code: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1 },
  },
} as const

export const storageFailureSummarySchema = {
  $id: 'StorageFailureSummary',
  ...storageFailureSummaryBody,
} as const

export interface StorageFailureSummary {
  source: 'object' | 'upload'
  code: string
  count: number
}

export const projectStorageOverviewSchema = {
  $id: 'ProjectStorageOverview',
  $defs: { StorageFailureSummary: storageFailureSummaryBody },
  type: 'object',
  additionalProperties: false,
  required: ['backend', 'health', 'usage', 'objects', 'uploads', 'failures', 'checkedAt'],
  properties: {
    backend: { type: 'string', enum: ['local', 's3'] },
    health: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'writable', 'capacity'],
      properties: {
        status: { type: 'string', enum: ['available', 'degraded', 'unavailable'] },
        writable: { type: 'boolean' },
        capacity: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['totalBytes', 'availableBytes'],
              properties: {
                totalBytes: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
                availableBytes: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
              },
            },
          ],
        },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['usedBytes', 'reservedBytes', 'quotaBytes', 'quotaRemainingBytes'],
      properties: {
        usedBytes: { type: 'integer', minimum: 0 },
        reservedBytes: { type: 'integer', minimum: 0 },
        quotaBytes: { type: 'integer', minimum: 1 },
        quotaRemainingBytes: { type: 'integer', minimum: 0 },
      },
    },
    objects: {
      type: 'object',
      additionalProperties: false,
      required: ['available', 'staging', 'failed'],
      properties: {
        available: { type: 'integer', minimum: 0 },
        staging: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
      },
    },
    uploads: {
      type: 'object',
      additionalProperties: false,
      required: ['active', 'failed', 'rejected', 'expired'],
      properties: {
        active: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        rejected: { type: 'integer', minimum: 0 },
        expired: { type: 'integer', minimum: 0 },
      },
    },
    failures: { type: 'array', items: { $ref: '#/$defs/StorageFailureSummary' } },
    checkedAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface ProjectStorageOverview {
  backend: 'local' | 's3'
  health: {
    status: 'available' | 'degraded' | 'unavailable'
    writable: boolean
    capacity: { totalBytes: string; availableBytes: string } | null
  }
  usage: {
    usedBytes: number
    reservedBytes: number
    quotaBytes: number
    quotaRemainingBytes: number
  }
  objects: { available: number; staging: number; failed: number }
  uploads: { active: number; failed: number; rejected: number; expired: number }
  failures: StorageFailureSummary[]
  checkedAt: string
}
