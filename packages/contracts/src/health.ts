export const serviceStatusSchema = {
  $id: 'ServiceStatus',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'version', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ok', 'ready'] },
    version: { type: 'string', minLength: 1 },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const

export interface ServiceStatus {
  status: 'ok' | 'ready'
  version: string
  timestamp: string
}
