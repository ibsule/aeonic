import { createHash } from 'node:crypto'
import type {
  AgentPlanBudget,
  AgentRiskClass,
  AgentTargetSnapshot,
  AgentToolCall,
  ReversibilityClass,
} from '@aeonic/contracts'

const riskRank: Record<AgentRiskClass, number> = {
  standard: 0,
  sensitive: 1,
  destructive: 2,
}

const reversibilityRank: Record<ReversibilityClass, number> = {
  reversible: 0,
  compensatable: 1,
  irreversible: 2,
}

export interface AgentToolPolicy {
  readonly name: string
  readonly access: 'read' | 'mutation'
  readonly riskClass: AgentRiskClass
  readonly reversibility: ReversibilityClass
  readonly requiredRole: 'owner' | 'admin'
  readonly maximumTargets: number
}

export interface AgentPlanProposal {
  readonly calls: readonly AgentToolCall[]
  readonly targets: readonly AgentTargetSnapshot[]
  readonly budget: AgentPlanBudget
  readonly estimatedCostMicroUsd: number
  readonly estimatedOutputBytes: number
}

export interface AgentPolicyDecision {
  readonly riskClass: AgentRiskClass
  readonly reversibility: ReversibilityClass
  readonly requiredRole: 'owner' | 'admin'
  readonly requiresApproval: boolean
}

export class AgentPolicyError extends Error {
  override readonly name = 'AgentPolicyError'

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function canonicalize(value: unknown, path = '$'): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`)
      .join(',')}}`
  }
  throw new TypeError(`${path} contains a value that cannot be represented in a plan.`)
}

export function canonicalPlanJson(plan: unknown): string {
  return canonicalize(plan)
}

export function hashAgentPlan(plan: unknown): string {
  return createHash('sha256').update(canonicalPlanJson(plan)).digest('hex')
}

function maximumByRank<T extends string>(values: readonly T[], ranks: Record<T, number>): T {
  const first = values[0]
  if (!first) throw new AgentPolicyError('empty_plan', 'An agent plan must contain a tool call.')
  return values.reduce((current, value) => (ranks[value] > ranks[current] ? value : current), first)
}

function assertBudget(proposal: AgentPlanProposal): void {
  const { budget } = proposal
  if (proposal.calls.length > budget.maxSteps) {
    throw new AgentPolicyError('step_budget_exceeded', 'The plan exceeds its maximum step budget.')
  }
  if (proposal.targets.length > budget.maxAssets) {
    throw new AgentPolicyError(
      'asset_budget_exceeded',
      'The plan exceeds its maximum asset budget.',
    )
  }
  if (proposal.estimatedCostMicroUsd > budget.maxCostMicroUsd) {
    throw new AgentPolicyError('cost_budget_exceeded', 'The plan exceeds its maximum cost budget.')
  }
  if (proposal.estimatedOutputBytes > budget.maxOutputBytes) {
    throw new AgentPolicyError(
      'output_budget_exceeded',
      'The plan exceeds its maximum output budget.',
    )
  }
}

export function evaluateAgentPlan(
  proposal: AgentPlanProposal,
  toolPolicies: readonly AgentToolPolicy[],
): AgentPolicyDecision {
  assertBudget(proposal)
  if (proposal.calls.length === 0) {
    throw new AgentPolicyError('empty_plan', 'An agent plan must contain a tool call.')
  }

  const policies = new Map(toolPolicies.map((policy) => [policy.name, policy]))
  if (policies.size !== toolPolicies.length) {
    throw new AgentPolicyError('invalid_tool_registry', 'Tool policy names must be unique.')
  }

  const callIds = new Set<string>()
  const snapshotIds = new Set<string>()
  for (const target of proposal.targets) {
    if (snapshotIds.has(target.assetId)) {
      throw new AgentPolicyError(
        'duplicate_target',
        `Asset ${target.assetId} has multiple snapshots.`,
      )
    }
    snapshotIds.add(target.assetId)
  }

  const selected: AgentToolPolicy[] = []
  for (const call of proposal.calls) {
    if (callIds.has(call.id)) {
      throw new AgentPolicyError('duplicate_call', `Tool call ${call.id} is duplicated.`)
    }
    callIds.add(call.id)

    const policy = policies.get(call.tool)
    if (!policy) {
      throw new AgentPolicyError('unknown_tool', `Tool ${call.tool} is not registered.`)
    }
    if (call.targetIds.length > policy.maximumTargets) {
      throw new AgentPolicyError(
        'tool_target_limit_exceeded',
        `Tool ${call.tool} exceeds its maximum target count.`,
      )
    }
    if (new Set(call.targetIds).size !== call.targetIds.length) {
      throw new AgentPolicyError('duplicate_call_target', `Tool call ${call.id} repeats a target.`)
    }
    for (const targetId of call.targetIds) {
      if (!snapshotIds.has(targetId)) {
        throw new AgentPolicyError(
          'missing_target_snapshot',
          `Tool call ${call.id} does not have a frozen snapshot for target ${targetId}.`,
        )
      }
    }
    if (policy.access === 'mutation' && call.targetIds.length === 0) {
      throw new AgentPolicyError(
        'mutation_without_target',
        `Mutation tool ${call.tool} requires at least one exact target.`,
      )
    }
    selected.push(policy)
  }

  return {
    riskClass: maximumByRank(
      selected.map((policy) => policy.riskClass),
      riskRank,
    ),
    reversibility: maximumByRank(
      selected.map((policy) => policy.reversibility),
      reversibilityRank,
    ),
    requiredRole: selected.some((policy) => policy.requiredRole === 'owner') ? 'owner' : 'admin',
    requiresApproval: selected.some((policy) => policy.access === 'mutation'),
  }
}
