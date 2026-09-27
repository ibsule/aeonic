export const jobStates = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type JobState = (typeof jobStates)[number]

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const

export const jobSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'type',
    'state',
    'progress',
    'attempts',
    'maxAttempts',
    'errorCode',
    'errorMessage',
    'createdAt',
    'updatedAt',
    'completedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', minLength: 1 },
    state: { type: 'string', enum: jobStates },
    progress: { type: 'integer', minimum: 0, maximum: 100 },
    attempts: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1 },
    errorCode: nullableString,
    errorMessage: nullableString,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
} as const

export interface Job {
  id: string
  type: string
  state: JobState
  progress: number
  attempts: number
  maxAttempts: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export const jobListSchema = {
  $id: 'JobList',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', maxItems: 100, items: jobSchema },
    nextCursor: nullableString,
  },
} as const

export interface JobList {
  items: Job[]
  nextCursor: string | null
}
