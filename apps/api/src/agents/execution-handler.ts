import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod/v4'
import type { DatabaseConnection } from '../db/database.js'
import { agentRuns, approvalRequests, assets, auditEvents, toolExecutions } from '../db/schema.js'
import { JobExecutionError, type JobHandler } from '../jobs/runner.js'
import type { JobRecord, TenantScope } from '../repositories/types.js'
import { hashAgentPlan } from './policy.js'
import { AgentWorkflowConflictError, SqliteAgentWorkflowRepository } from './repository.js'

const payloadSchema = z
  .object({
    executionId: z.uuid(),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

const metadataArgumentsSchema = z
  .object({
    assetId: z.uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    folder: z.string().trim().max(500).optional(),
    visibility: z.enum(['private', 'public']).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined || input.folder !== undefined || input.visibility !== undefined,
    { message: 'At least one metadata change is required.' },
  )

function executionFailure(error: unknown): JobExecutionError {
  if (error instanceof JobExecutionError) return error
  if (error instanceof AgentWorkflowConflictError) {
    return new JobExecutionError(error.code, error.message, false, { cause: error })
  }
  if (error instanceof z.ZodError) {
    return new JobExecutionError(
      'invalid_tool_arguments',
      'The approved tool arguments are invalid.',
      false,
      { cause: error },
    )
  }
  return new JobExecutionError(
    'agent_execution_failed',
    'The approved tool could not execute.',
    true,
    {
      cause: error,
    },
  )
}

export class AgentToolExecutionHandler {
  readonly handle: JobHandler

  constructor(
    private readonly database: DatabaseConnection,
    private readonly workflows = new SqliteAgentWorkflowRepository(database),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.handle = async (job, context) => {
      const now = this.now()
      let executionId: string | undefined
      try {
        if (context.signal.aborted) {
          throw new JobExecutionError('execution_interrupted', 'Execution was interrupted.', true)
        }
        const payload = payloadSchema.parse(job.payload)
        executionId = payload.executionId
        this.execute(job, payload, now)
      } catch (error) {
        const failure = executionFailure(error)
        if (executionId) {
          this.recordFailure(
            job,
            executionId,
            failure,
            failure.retryable === false || job.attempts >= job.maxAttempts,
            now,
          )
        }
        throw failure
      }
    }
  }

  private execute(job: JobRecord, payload: z.infer<typeof payloadSchema>, now: Date): void {
    const scope = { organizationId: job.organizationId, projectId: job.projectId }
    const transaction = this.database.client.transaction(() => {
      const execution = this.findExecution(scope, payload.executionId)
      if (!execution) {
        throw new JobExecutionError(
          'execution_not_found',
          'The approved tool execution does not exist.',
          false,
        )
      }
      if (execution.state === 'succeeded') return
      if (execution.state === 'cancelled' || execution.state === 'skipped') {
        throw new JobExecutionError('execution_cancelled', 'The execution was cancelled.', false)
      }
      const plan = this.workflows.findPlan(scope, execution.planId)
      if (!plan || plan.planHash !== payload.planHash) {
        throw new AgentWorkflowConflictError(
          'plan_mismatch',
          'The execution does not match its immutable approved plan.',
        )
      }
      const approval = this.database.db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, execution.approvalRequestId),
            eq(approvalRequests.organizationId, scope.organizationId),
            eq(approvalRequests.projectId, scope.projectId),
          ),
        )
        .get()
      const run = this.workflows.findRun(scope, execution.runId)
      if (approval?.state !== 'consumed' || run?.state !== 'executing') {
        throw new AgentWorkflowConflictError(
          'execution_not_authorized',
          'The plan no longer has a consumed approval and executing run.',
        )
      }
      if (
        !approval.consumedAt ||
        now.getTime() - approval.consumedAt.getTime() > plan.budget.maxWallTimeMs
      ) {
        throw new AgentWorkflowConflictError(
          'wall_time_budget_exceeded',
          'The approved execution exceeded its wall-time budget.',
        )
      }
      const call = plan.toolCalls.find((candidate) => candidate.id === execution.callId)
      if (
        !call ||
        call.tool !== execution.toolName ||
        hashAgentPlan(call.arguments) !== execution.argumentsHash
      ) {
        throw new AgentWorkflowConflictError(
          'tool_call_mismatch',
          'The queued execution does not match the approved tool call.',
        )
      }
      if (run.stepsUsed + 1 > plan.budget.maxSteps) {
        throw new AgentWorkflowConflictError(
          'step_budget_exceeded',
          'The approved execution would exceed its step budget.',
        )
      }
      this.workflows.assertTargetsCurrent(scope, plan.targetSnapshot)
      if (call.tool !== 'assets.update_metadata') {
        throw new JobExecutionError(
          'unsupported_agent_tool',
          'The approved tool is not supported by this worker.',
          false,
        )
      }
      const input = metadataArgumentsSchema.parse(call.arguments)
      const target = plan.targetSnapshot.find((snapshot) => snapshot.assetId === input.assetId)
      if (!target) {
        throw new AgentWorkflowConflictError(
          'target_not_approved',
          'The tool target was not present in the approved snapshot.',
        )
      }
      const current = this.database.db
        .select({ name: assets.name, folder: assets.folder, visibility: assets.visibility })
        .from(assets)
        .where(
          and(
            eq(assets.id, input.assetId),
            eq(assets.organizationId, scope.organizationId),
            eq(assets.projectId, scope.projectId),
            eq(assets.updatedAt, new Date(target.assetUpdatedAt)),
          ),
        )
        .get()
      if (!current) {
        throw new AgentWorkflowConflictError(
          'target_snapshot_changed',
          'The approved asset changed before execution.',
        )
      }
      const after = {
        name: input.name ?? current.name,
        folder: input.folder ?? current.folder,
        visibility: input.visibility ?? current.visibility,
      }
      this.database.db
        .update(toolExecutions)
        .set({ state: 'running', attempt: job.attempts, startedAt: now, completedAt: null })
        .where(eq(toolExecutions.id, execution.id))
        .run()
      const changed = this.database.db
        .update(assets)
        .set({ ...after, updatedAt: now })
        .where(
          and(
            eq(assets.id, input.assetId),
            eq(assets.organizationId, scope.organizationId),
            eq(assets.projectId, scope.projectId),
            eq(assets.updatedAt, new Date(target.assetUpdatedAt)),
          ),
        )
        .run()
      if (changed.changes !== 1) {
        throw new AgentWorkflowConflictError(
          'target_snapshot_changed',
          'The approved asset changed while execution was starting.',
        )
      }
      this.database.db
        .update(toolExecutions)
        .set({ state: 'succeeded', result: { assetId: input.assetId }, completedAt: now })
        .where(eq(toolExecutions.id, execution.id))
        .run()
      this.database.db
        .update(agentRuns)
        .set({
          state: 'succeeded',
          stepsUsed: run.stepsUsed + 1,
          updatedAt: now,
          completedAt: now,
        })
        .where(eq(agentRuns.id, run.id))
        .run()
      this.database.db
        .insert(auditEvents)
        .values([
          {
            id: uuidv7(),
            ...scope,
            actorType: 'system',
            actorId: null,
            action: 'asset.updated_by_agent',
            targetType: 'asset',
            targetId: input.assetId,
            requestId: `agent:${execution.id}`,
            summary: {
              planId: plan.id,
              planHash: plan.planHash,
              approvalId: approval.id,
              before: current,
              after,
            },
            createdAt: now,
          },
          {
            id: uuidv7(),
            ...scope,
            actorType: 'system',
            actorId: null,
            action: 'agent.tool_succeeded',
            targetType: 'tool_execution',
            targetId: execution.id,
            requestId: `agent:${execution.id}`,
            summary: { planId: plan.id, planHash: plan.planHash, tool: call.tool },
            createdAt: now,
          },
        ])
        .run()
    })
    transaction.immediate()
  }

  private recordFailure(
    job: JobRecord,
    executionId: string,
    failure: JobExecutionError,
    terminal: boolean,
    now: Date,
  ): void {
    const scope = { organizationId: job.organizationId, projectId: job.projectId }
    const execution = this.findExecution(scope, executionId)
    if (!execution || execution.state === 'succeeded' || execution.state === 'cancelled') return
    this.database.db
      .update(toolExecutions)
      .set({
        state: terminal ? 'failed' : 'queued',
        attempt: job.attempts,
        errorCode: failure.code,
        startedAt: terminal ? (execution.startedAt ?? now) : null,
        completedAt: terminal ? now : null,
      })
      .where(eq(toolExecutions.id, executionId))
      .run()
    if (terminal) {
      this.database.db
        .update(agentRuns)
        .set({ state: 'failed', updatedAt: now, completedAt: now })
        .where(
          and(
            eq(agentRuns.id, execution.runId),
            eq(agentRuns.organizationId, scope.organizationId),
            eq(agentRuns.projectId, scope.projectId),
            eq(agentRuns.state, 'executing'),
          ),
        )
        .run()
    }
  }

  private findExecution(scope: TenantScope, executionId: string) {
    return this.database.db
      .select()
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.id, executionId),
          eq(toolExecutions.organizationId, scope.organizationId),
          eq(toolExecutions.projectId, scope.projectId),
        ),
      )
      .get()
  }
}
