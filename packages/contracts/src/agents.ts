export const agentRunStates = [
  'planning',
  'awaiting_approval',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type AgentRunState = (typeof agentRunStates)[number]

export const approvalStates = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'consumed',
] as const
export type ApprovalState = (typeof approvalStates)[number]

export const agentRiskClasses = ['standard', 'sensitive', 'destructive'] as const
export type AgentRiskClass = (typeof agentRiskClasses)[number]

export const reversibilityClasses = ['reversible', 'compensatable', 'irreversible'] as const
export type ReversibilityClass = (typeof reversibilityClasses)[number]

export const toolExecutionStates = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const
export type ToolExecutionState = (typeof toolExecutionStates)[number]

function embeddedSchema<T extends { $id: string }>(schema: T): Omit<T, '$id'> {
  const { $id: _id, ...embedded } = schema
  return embedded
}

export interface AgentPlanBudget {
  maxSteps: number
  maxWallTimeMs: number
  maxTokens: number
  maxCostMicroUsd: number
  maxAssets: number
  maxOutputBytes: number
  maxRetries: number
}

export const agentPlanBudgetSchema = {
  $id: 'AgentPlanBudget',
  type: 'object',
  additionalProperties: false,
  required: [
    'maxSteps',
    'maxWallTimeMs',
    'maxTokens',
    'maxCostMicroUsd',
    'maxAssets',
    'maxOutputBytes',
    'maxRetries',
  ],
  properties: {
    maxSteps: { type: 'integer', minimum: 1, maximum: 100 },
    maxWallTimeMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
    maxTokens: { type: 'integer', minimum: 0, maximum: 1000000 },
    maxCostMicroUsd: { type: 'integer', minimum: 0 },
    maxAssets: { type: 'integer', minimum: 1, maximum: 10000 },
    maxOutputBytes: { type: 'integer', minimum: 0 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10 },
  },
} as const

export interface AgentTargetSnapshot {
  assetId: string
  assetVersionId: string
  assetVersion: number
  assetUpdatedAt: string
}

export const agentTargetSnapshotSchema = {
  $id: 'AgentTargetSnapshot',
  type: 'object',
  additionalProperties: false,
  required: ['assetId', 'assetVersionId', 'assetVersion', 'assetUpdatedAt'],
  properties: {
    assetId: { type: 'string', format: 'uuid' },
    assetVersionId: { type: 'string', format: 'uuid' },
    assetVersion: { type: 'integer', minimum: 1 },
    assetUpdatedAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface AgentToolCall {
  id: string
  tool: string
  arguments: Record<string, unknown>
  expectedEffect: string
  targetIds: string[]
}

export const agentToolCallSchema = {
  $id: 'AgentToolCall',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tool', 'arguments', 'expectedEffect', 'targetIds'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9][a-z0-9_-]*$' },
    tool: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_.-]*$' },
    arguments: { type: 'object', additionalProperties: true },
    expectedEffect: { type: 'string', minLength: 1, maxLength: 500 },
    targetIds: {
      type: 'array',
      maxItems: 10000,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
  },
} as const

export interface AgentPlan {
  id: string
  runId: string
  organizationId: string
  projectId: string
  hash: string
  summary: string
  riskClass: AgentRiskClass
  reversibility: ReversibilityClass
  requiredRole: 'owner' | 'admin'
  calls: AgentToolCall[]
  targets: AgentTargetSnapshot[]
  budget: AgentPlanBudget
  expiresAt: string
  createdAt: string
}

export const agentPlanSchema = {
  $id: 'AgentPlan',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'runId',
    'organizationId',
    'projectId',
    'hash',
    'summary',
    'riskClass',
    'reversibility',
    'requiredRole',
    'calls',
    'targets',
    'budget',
    'expiresAt',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    runId: { type: 'string', format: 'uuid' },
    organizationId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    riskClass: { type: 'string', enum: agentRiskClasses },
    reversibility: { type: 'string', enum: reversibilityClasses },
    requiredRole: { type: 'string', enum: ['owner', 'admin'] },
    calls: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: embeddedSchema(agentToolCallSchema),
    },
    targets: {
      type: 'array',
      maxItems: 10000,
      items: embeddedSchema(agentTargetSnapshotSchema),
    },
    budget: embeddedSchema(agentPlanBudgetSchema),
    expiresAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface AgentRun {
  id: string
  organizationId: string
  projectId: string
  state: AgentRunState
  request: string
  provider: string | null
  model: string | null
  budget: AgentPlanBudget
  stepsUsed: number
  tokensUsed: number
  costMicroUsd: number
  createdBy: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}

export const agentRunSchema = {
  $id: 'AgentRun',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organizationId',
    'projectId',
    'state',
    'request',
    'provider',
    'model',
    'budget',
    'stepsUsed',
    'tokensUsed',
    'costMicroUsd',
    'createdBy',
    'createdAt',
    'updatedAt',
    'completedAt',
    'cancelledAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    organizationId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: agentRunStates },
    request: { type: 'string', minLength: 1 },
    provider: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    budget: embeddedSchema(agentPlanBudgetSchema),
    stepsUsed: { type: 'integer', minimum: 0 },
    tokensUsed: { type: 'integer', minimum: 0 },
    costMicroUsd: { type: 'integer', minimum: 0 },
    createdBy: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    cancelledAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const

export interface ApprovalRequest {
  id: string
  planId: string
  planHash: string
  state: ApprovalState
  requestedBy: string
  decidedBy: string | null
  decisionReason: string | null
  expiresAt: string
  createdAt: string
  decidedAt: string | null
  consumedAt: string | null
}

export const approvalRequestSchema = {
  $id: 'ApprovalRequest',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'planId',
    'planHash',
    'state',
    'requestedBy',
    'decidedBy',
    'decisionReason',
    'expiresAt',
    'createdAt',
    'decidedAt',
    'consumedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    planId: { type: 'string', format: 'uuid' },
    planHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    state: { type: 'string', enum: approvalStates },
    requestedBy: { type: 'string', format: 'uuid' },
    decidedBy: { type: ['string', 'null'], format: 'uuid' },
    decisionReason: { type: ['string', 'null'], maxLength: 1000 },
    expiresAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    decidedAt: { type: ['string', 'null'], format: 'date-time' },
    consumedAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const

export interface AgentApprovalInboxItem {
  approval: ApprovalRequest
  plan: AgentPlan
  run: AgentRun
}

export interface AgentApprovalInbox {
  items: AgentApprovalInboxItem[]
}

export const agentApprovalInboxSchema = {
  $id: 'AgentApprovalInbox',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['approval', 'plan', 'run'],
        properties: {
          approval: embeddedSchema(approvalRequestSchema),
          plan: embeddedSchema(agentPlanSchema),
          run: embeddedSchema(agentRunSchema),
        },
      },
    },
  },
} as const

export interface ApprovalDecisionRequest {
  decision: 'approved' | 'rejected'
  reason?: string
}

export const approvalDecisionRequestSchema = {
  $id: 'ApprovalDecisionRequest',
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const

export interface ConsumeApprovalRequest {
  planHash: string
}

export const consumeApprovalRequestSchema = {
  $id: 'ConsumeApprovalRequest',
  type: 'object',
  additionalProperties: false,
  required: ['planHash'],
  properties: { planHash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
} as const
