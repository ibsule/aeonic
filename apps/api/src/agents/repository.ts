import { and, asc, eq } from 'drizzle-orm'
import type {
  AgentPlanBudget,
  AgentRiskClass,
  AgentTargetSnapshot,
  AgentToolCall,
  ReversibilityClass,
} from '@aeonic/contracts'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { agentPlans, agentRuns, approvalRequests } from '../db/schema.js'
import type { TenantScope } from '../repositories/types.js'
import { hashAgentPlan } from './policy.js'

export type AgentRunRecord = typeof agentRuns.$inferSelect
export type AgentPlanRecord = typeof agentPlans.$inferSelect
export type ApprovalRequestRecord = typeof approvalRequests.$inferSelect

export class AgentWorkflowConflictError extends Error {
  override readonly name = 'AgentWorkflowConflictError'

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface CreateAgentRunInput extends TenantScope {
  readonly request: string
  readonly provider?: string
  readonly model?: string
  readonly budget: AgentPlanBudget
  readonly createdBy: string
  readonly now: Date
}

export interface FreezeAgentPlanInput extends TenantScope {
  readonly runId: string
  readonly plannerVersion: string
  readonly summary: string
  readonly riskClass: AgentRiskClass
  readonly reversibility: ReversibilityClass
  readonly requiredRole: 'owner' | 'admin'
  readonly calls: readonly AgentToolCall[]
  readonly targets: readonly AgentTargetSnapshot[]
  readonly budget: AgentPlanBudget
  readonly estimatedCostMicroUsd: number
  readonly estimatedOutputBytes: number
  readonly requestedBy: string
  readonly expiresAt: Date
  readonly now: Date
}

export interface FrozenAgentPlan {
  readonly plan: AgentPlanRecord
  readonly approval: ApprovalRequestRecord
}

interface PlanHashFields {
  readonly id: string
  readonly organizationId: string
  readonly projectId: string
  readonly runId: string
  readonly plannerVersion: string
  readonly summary: string
  readonly riskClass: AgentRiskClass
  readonly reversibility: ReversibilityClass
  readonly requiredRole: 'owner' | 'admin'
  readonly toolCalls: AgentToolCall[]
  readonly targetSnapshot: AgentTargetSnapshot[]
  readonly budget: AgentPlanBudget
  readonly estimatedCostMicroUsd: number
  readonly estimatedOutputBytes: number
  readonly expiresAt: Date
  readonly createdAt: Date
}

export function calculateStoredPlanHash(plan: PlanHashFields): string {
  return hashAgentPlan({
    schemaVersion: 1,
    id: plan.id,
    organizationId: plan.organizationId,
    projectId: plan.projectId,
    runId: plan.runId,
    plannerVersion: plan.plannerVersion,
    summary: plan.summary,
    riskClass: plan.riskClass,
    reversibility: plan.reversibility,
    requiredRole: plan.requiredRole,
    toolCalls: plan.toolCalls,
    targetSnapshot: plan.targetSnapshot,
    budget: plan.budget,
    estimatedCostMicroUsd: plan.estimatedCostMicroUsd,
    estimatedOutputBytes: plan.estimatedOutputBytes,
    expiresAt: plan.expiresAt.toISOString(),
    createdAt: plan.createdAt.toISOString(),
  })
}

function assertFutureExpiry(now: Date, expiresAt: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now
  ) {
    throw new TypeError('Agent plan approval must expire after it is created.')
  }
}

function assertPlanIntegrity(plan: AgentPlanRecord): void {
  if (calculateStoredPlanHash(plan) !== plan.planHash) {
    throw new AgentWorkflowConflictError(
      'plan_integrity_failed',
      'The stored plan no longer matches its immutable hash.',
    )
  }
}

export class SqliteAgentWorkflowRepository {
  constructor(private readonly database: DatabaseConnection) {}

  createRun(input: CreateAgentRunInput): AgentRunRecord {
    if (input.request.trim() === '') throw new TypeError('Agent requests cannot be empty.')
    const id = uuidv7()
    this.database.db
      .insert(agentRuns)
      .values({
        id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        request: input.request,
        provider: input.provider,
        model: input.model,
        budget: input.budget,
        createdBy: input.createdBy,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return this.database.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .get() as AgentRunRecord
  }

  freezePlanAndRequestApproval(input: FreezeAgentPlanInput): FrozenAgentPlan {
    assertFutureExpiry(input.now, input.expiresAt)
    const transaction = this.database.client.transaction(() => {
      const run = this.findRun(input, input.runId)
      if (run?.state !== 'planning') {
        throw new AgentWorkflowConflictError(
          'run_not_planning',
          'Only a planning run can freeze a plan.',
        )
      }

      const planId = uuidv7()
      const approvalId = uuidv7()
      const planFields: PlanHashFields = {
        id: planId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        plannerVersion: input.plannerVersion,
        summary: input.summary,
        riskClass: input.riskClass,
        reversibility: input.reversibility,
        requiredRole: input.requiredRole,
        toolCalls: [...input.calls],
        targetSnapshot: [...input.targets],
        budget: input.budget,
        estimatedCostMicroUsd: input.estimatedCostMicroUsd,
        estimatedOutputBytes: input.estimatedOutputBytes,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      }
      const planHash = calculateStoredPlanHash(planFields)
      this.database.db
        .insert(agentPlans)
        .values({ ...planFields, planHash })
        .run()
      this.database.db
        .insert(approvalRequests)
        .values({
          id: approvalId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          planId,
          planHash,
          requestedBy: input.requestedBy,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        })
        .run()
      const changed = this.database.db
        .update(agentRuns)
        .set({ state: 'awaiting_approval', updatedAt: input.now })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.organizationId, input.organizationId),
            eq(agentRuns.projectId, input.projectId),
            eq(agentRuns.state, 'planning'),
          ),
        )
        .run()
      if (changed.changes !== 1) {
        throw new AgentWorkflowConflictError(
          'run_changed',
          'The agent run changed while freezing its plan.',
        )
      }
      return {
        plan: this.database.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).get(),
        approval: this.database.db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalId))
          .get(),
      }
    })
    return transaction.immediate() as FrozenAgentPlan
  }

  findRun(scope: TenantScope, runId: string): AgentRunRecord | null {
    return (
      this.database.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.organizationId, scope.organizationId),
            eq(agentRuns.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    )
  }

  findPlan(scope: TenantScope, planId: string): AgentPlanRecord | null {
    const plan =
      this.database.db
        .select()
        .from(agentPlans)
        .where(
          and(
            eq(agentPlans.id, planId),
            eq(agentPlans.organizationId, scope.organizationId),
            eq(agentPlans.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    if (plan) assertPlanIntegrity(plan)
    return plan
  }

  listPendingApprovals(scope: TenantScope, now: Date): readonly ApprovalRequestRecord[] {
    this.expirePending(scope, now)
    return this.database.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.organizationId, scope.organizationId),
          eq(approvalRequests.projectId, scope.projectId),
          eq(approvalRequests.state, 'pending'),
        ),
      )
      .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id))
      .all()
  }

  decideApproval(
    scope: TenantScope,
    approvalId: string,
    decision: 'approved' | 'rejected',
    actor: { id: string; role: 'owner' | 'admin' },
    now: Date,
    reason?: string,
  ): ApprovalRequestRecord {
    const transaction = this.database.client.transaction(() => {
      this.expirePending(scope, now)
      const approval = this.findApproval(scope, approvalId)
      if (approval?.state !== 'pending') {
        throw new AgentWorkflowConflictError(
          'approval_not_pending',
          'Only a pending, unexpired request can be decided.',
        )
      }
      const plan = this.findPlan(scope, approval.planId)
      if (!plan || plan.planHash !== approval.planHash) {
        throw new AgentWorkflowConflictError(
          'plan_mismatch',
          'The approval does not match its plan.',
        )
      }
      if (plan.requiredRole === 'owner' && actor.role !== 'owner') {
        throw new AgentWorkflowConflictError(
          'approval_role_required',
          'This plan requires an organization owner to approve it.',
        )
      }
      this.database.db
        .update(approvalRequests)
        .set({
          state: decision,
          decidedBy: actor.id,
          decisionReason: reason?.trim() || null,
          decidedAt: now,
        })
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.organizationId, scope.organizationId),
            eq(approvalRequests.projectId, scope.projectId),
            eq(approvalRequests.state, 'pending'),
          ),
        )
        .run()
      return this.findApproval(scope, approvalId)
    })
    return transaction.immediate() as ApprovalRequestRecord
  }

  consumeApproval(
    scope: TenantScope,
    approvalId: string,
    expectedPlanHash: string,
    now: Date,
  ): FrozenAgentPlan {
    const transaction = this.database.client.transaction(() => {
      const approval = this.findApproval(scope, approvalId)
      if (approval?.state !== 'approved' || approval.expiresAt <= now) {
        throw new AgentWorkflowConflictError(
          'approval_not_usable',
          'The approval is not approved, has expired, or was already consumed.',
        )
      }
      const plan = this.findPlan(scope, approval.planId)
      if (!plan || plan.planHash !== approval.planHash || plan.planHash !== expectedPlanHash) {
        throw new AgentWorkflowConflictError(
          'plan_mismatch',
          'The approved plan hash does not match the execution request.',
        )
      }
      const consumed = this.database.db
        .update(approvalRequests)
        .set({ state: 'consumed', consumedAt: now })
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.organizationId, scope.organizationId),
            eq(approvalRequests.projectId, scope.projectId),
            eq(approvalRequests.state, 'approved'),
          ),
        )
        .run()
      const started = this.database.db
        .update(agentRuns)
        .set({ state: 'executing', updatedAt: now })
        .where(
          and(
            eq(agentRuns.id, plan.runId),
            eq(agentRuns.organizationId, scope.organizationId),
            eq(agentRuns.projectId, scope.projectId),
            eq(agentRuns.state, 'awaiting_approval'),
          ),
        )
        .run()
      if (consumed.changes !== 1 || started.changes !== 1) {
        throw new AgentWorkflowConflictError(
          'approval_race_lost',
          'The approval or run was changed before execution could begin.',
        )
      }
      return { plan, approval: this.findApproval(scope, approvalId) }
    })
    return transaction.immediate() as FrozenAgentPlan
  }

  private findApproval(scope: TenantScope, approvalId: string): ApprovalRequestRecord | null {
    return (
      this.database.db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, approvalId),
            eq(approvalRequests.organizationId, scope.organizationId),
            eq(approvalRequests.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    )
  }

  private expirePending(scope: TenantScope, now: Date): void {
    this.database.client
      .prepare(
        `update approval_requests
            set state = 'expired'
          where organization_id = ? and project_id = ? and state = 'pending' and expires_at <= ?`,
      )
      .run(scope.organizationId, scope.projectId, now.getTime())
  }
}
