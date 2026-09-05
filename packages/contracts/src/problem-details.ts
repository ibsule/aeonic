export const problemDetailsSchema = {
  $id: 'ProblemDetails',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code', 'requestId'],
  properties: {
    type: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string', pattern: '^[a-z0-9_]+$' },
    requestId: { type: 'string', minLength: 1 },
  },
} as const

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code: string
  requestId: string
}
