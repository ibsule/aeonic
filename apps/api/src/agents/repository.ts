import { and, asc, eq, inArray, or } from 'drizzle-orm'
import type {
  AgentPlanBudget,
  AgentRiskClass,
  AgentTargetSnapshot,
  AgentToolCall,
  ReversibilityClass,
} from '@aeonic/contracts'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import {
  agentPlans,
  agentRuns,
  approvalRequests,
  assets,
  assetVersions,
  auditEvents,
  jobs,
  toolExecutions,
} from '../db/schema.js'
import type { TenantScope } from '../repositories/types.js'
import { canonicalPlanJson, hashAgentPlan } from './policy.js'

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
  readonly idempotencyKey?: string
  readonly provider?: string
  readonly model?: string
  readonly budget: AgentPlanBudget
  readonly createdBy: string
  readonly requestId: string
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
  readonly requestId: string
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
    if (input.idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
      throw new TypeError('Agent idempotency keys must contain 8 to 128 safe ASCII characters.')
    }
    const id = uuidv7()
    const transaction = this.database.client.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.database.db
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.organizationId, input.organizationId),
              eq(agentRuns.projectId, input.projectId),
              eq(agentRuns.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get()
        if (existing) {
          if (
            existing.request !== input.request ||
            existing.provider !== (input.provider ?? null) ||
            existing.model !== (input.model ?? null) ||
            canonicalPlanJson(existing.budget) !== canonicalPlanJson(input.budget)
          ) {
            throw new AgentWorkflowConflictError(
              'idempotency_conflict',
              'This idempotency key was already used for a different agent request.',
            )
          }
          return existing
        }
      }
      this.database.db
        .insert(agentRuns)
        .values({
          id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          request: input.request,
          idempotencyKey: input.idempotencyKey,
          provider: input.provider,
          model: input.model,
          budget: input.budget,
          createdBy: input.createdBy,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run()
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorType: 'user',
          actorId: input.createdBy,
          action: 'agent.run_created',
          targetType: 'agent_run',
          targetId: id,
          requestId: input.requestId,
          summary: { request: input.request },
          createdAt: input.now,
        })
        .run()
      return this.database.db.select().from(agentRuns).where(eq(agentRuns.id, id)).get()
    })
    return transaction.immediate() as AgentRunRecord
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
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorType: 'user',
          actorId: input.requestedBy,
          action: 'agent.approval_requested',
          targetType: 'agent_plan',
          targetId: planId,
          requestId: input.requestId,
          summary: {
            approvalId,
            planHash,
            riskClass: input.riskClass,
            targetIds: input.targets.map((target) => target.assetId),
          },
          createdAt: input.now,
        })
        .run()
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

  findPlanByRun(scope: TenantScope, runId: string): AgentPlanRecord | null {
    const plan =
      this.database.db
        .select()
        .from(agentPlans)
        .where(
          and(
            eq(agentPlans.runId, runId),
            eq(agentPlans.organizationId, scope.organizationId),
            eq(agentPlans.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    if (plan) assertPlanIntegrity(plan)
    return plan
  }

  findApprovalForPlan(scope: TenantScope, planId: string): ApprovalRequestRecord | null {
    return (
      this.database.db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.planId, planId),
            eq(approvalRequests.organizationId, scope.organizationId),
            eq(approvalRequests.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    )
  }

  listActionableApprovals(scope: TenantScope, now: Date): readonly ApprovalRequestRecord[] {
    this.expirePending(scope, now)
    return this.database.db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.organizationId, scope.organizationId),
          eq(approvalRequests.projectId, scope.projectId),
          or(eq(approvalRequests.state, 'pending'), eq(approvalRequests.state, 'approved')),
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
    requestId = 'agent-internal',
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
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          actorType: 'user',
          actorId: actor.id,
          action: `agent.approval_${decision}`,
          targetType: 'approval_request',
          targetId: approvalId,
          requestId,
          summary: { planId: plan.id, planHash: plan.planHash, reason: reason?.trim() || null },
          createdAt: now,
        })
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
    actorId = 'system',
    requestId = 'agent-internal',
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
      this.assertTargetsCurrent(scope, plan.targetSnapshot)
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
      for (const call of plan.toolCalls) {
        const executionId = uuidv7()
        this.database.db
          .insert(toolExecutions)
          .values({
            id: executionId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            runId: plan.runId,
            planId: plan.id,
            approvalRequestId: approval.id,
            callId: call.id,
            toolName: call.tool,
            argumentsHash: hashAgentPlan(call.arguments),
            idempotencyKey: hashAgentPlan({ planHash: plan.planHash, callId: call.id }),
            createdAt: now,
          })
          .run()
        this.database.db
          .insert(jobs)
          .values({
            id: executionId,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            type: 'agent.execute_tool',
            payload: { executionId, planHash: plan.planHash },
            maxAttempts: plan.budget.maxRetries + 1,
            runAfter: now,
            createdBy: approval.decidedBy,
            createdAt: now,
            updatedAt: now,
          })
          .run()
      }
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          actorType: actorId === 'system' ? 'system' : 'user',
          actorId: actorId === 'system' ? null : actorId,
          action: 'agent.approval_consumed',
          targetType: 'agent_plan',
          targetId: plan.id,
          requestId,
          summary: {
            approvalId,
            planHash: plan.planHash,
            callIds: plan.toolCalls.map((call) => call.id),
          },
          createdAt: now,
        })
        .run()
      return { plan, approval: this.findApproval(scope, approvalId) }
    })
    return transaction.immediate() as FrozenAgentPlan
  }

  findApproval(scope: TenantScope, approvalId: string): ApprovalRequestRecord | null {
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

  cancelRun(
    scope: TenantScope,
    runId: string,
    actorId: string,
    now: Date,
    requestId: string,
    reason?: string,
  ): AgentRunRecord {
    const transaction = this.database.client.transaction(() => {
      const run = this.findRun(scope, runId)
      if (!run) {
        throw new AgentWorkflowConflictError('run_not_found', 'The agent run does not exist.')
      }
      if (run.state === 'cancelled') return run
      if (run.state === 'succeeded' || run.state === 'failed') {
        throw new AgentWorkflowConflictError(
          'run_already_finished',
          'A completed agent run cannot be cancelled.',
        )
      }
      const changed = this.database.db
        .update(agentRuns)
        .set({ state: 'cancelled', updatedAt: now, completedAt: now, cancelledAt: now })
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.organizationId, scope.organizationId),
            eq(agentRuns.projectId, scope.projectId),
            or(
              eq(agentRuns.state, 'planning'),
              eq(agentRuns.state, 'awaiting_approval'),
              eq(agentRuns.state, 'executing'),
            ),
          ),
        )
        .run()
      if (changed.changes !== 1) {
        throw new AgentWorkflowConflictError(
          'run_cancel_race_lost',
          'The agent run changed before it could be cancelled.',
        )
      }
      const plan = this.findPlanByRun(scope, runId)
      if (plan) {
        this.database.db
          .update(approvalRequests)
          .set({ state: 'cancelled' })
          .where(
            and(
              eq(approvalRequests.planId, plan.id),
              eq(approvalRequests.organizationId, scope.organizationId),
              eq(approvalRequests.projectId, scope.projectId),
              eq(approvalRequests.state, 'pending'),
            ),
          )
          .run()
      }
      const executions = this.database.db
        .select()
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.runId, runId),
            eq(toolExecutions.organizationId, scope.organizationId),
            eq(toolExecutions.projectId, scope.projectId),
            or(eq(toolExecutions.state, 'queued'), eq(toolExecutions.state, 'running')),
          ),
        )
        .all()
      for (const execution of executions) {
        this.database.db
          .update(toolExecutions)
          .set({
            state: 'cancelled',
            startedAt: execution.startedAt ?? now,
            completedAt: now,
            errorCode: 'run_cancelled',
          })
          .where(eq(toolExecutions.id, execution.id))
          .run()
      }
      if (executions.length > 0) {
        this.database.db
          .update(jobs)
          .set({
            state: 'cancelled',
            leaseOwner: null,
            leaseExpiresAt: null,
            errorCode: 'run_cancelled',
            errorMessage: 'The operator cancelled the agent run.',
            updatedAt: now,
            completedAt: now,
          })
          .where(
            and(
              inArray(
                jobs.id,
                executions.map((execution) => execution.id),
              ),
              or(eq(jobs.state, 'queued'), eq(jobs.state, 'running')),
            ),
          )
          .run()
      }
      this.database.db
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          ...scope,
          actorType: 'user',
          actorId,
          action: 'agent.run_cancelled',
          targetType: 'agent_run',
          targetId: runId,
          requestId,
          summary: { planId: plan?.id ?? null, reason: reason?.trim() || null },
          createdAt: now,
        })
        .run()
      return this.findRun(scope, runId)
    })
    return transaction.immediate() as AgentRunRecord
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

  assertTargetsCurrent(scope: TenantScope, snapshots: readonly AgentTargetSnapshot[]): void {
    for (const snapshot of snapshots) {
      const target = this.database.db
        .select({
          assetUpdatedAt: assets.updatedAt,
          currentVersion: assets.currentVersion,
          assetVersionId: assetVersions.id,
          assetVersion: assetVersions.version,
        })
        .from(assets)
        .innerJoin(
          assetVersions,
          and(
            eq(assetVersions.assetId, assets.id),
            eq(assetVersions.organizationId, assets.organizationId),
            eq(assetVersions.projectId, assets.projectId),
            eq(assetVersions.version, assets.currentVersion),
          ),
        )
        .where(
          and(
            eq(assets.id, snapshot.assetId),
            eq(assets.organizationId, scope.organizationId),
            eq(assets.projectId, scope.projectId),
          ),
        )
        .get()
      if (
        !target ||
        target.assetVersionId !== snapshot.assetVersionId ||
        target.assetVersion !== snapshot.assetVersion ||
        target.currentVersion !== snapshot.assetVersion ||
        target.assetUpdatedAt.toISOString() !== snapshot.assetUpdatedAt
      ) {
        throw new AgentWorkflowConflictError(
          'target_snapshot_changed',
          `Asset ${snapshot.assetId} changed after this plan was created.`,
        )
      }
    }
  }
}
