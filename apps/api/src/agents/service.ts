import type {
  AgentApprovalInbox,
  AgentPlan,
  AgentRun,
  ApprovalDecisionRequest,
  ApprovalRequest,
  CancelAgentRunRequest,
} from '@aeonic/contracts'
import type { OrganizationRole } from '../authorization/policy.js'
import { ApiError } from '../http/api-error.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import {
  AgentWorkflowConflictError,
  type AgentPlanRecord,
  type AgentRunRecord,
  type ApprovalRequestRecord,
  type SqliteAgentWorkflowRepository,
} from './repository.js'

function approvalAdmin(role: OrganizationRole): role is 'owner' | 'admin' {
  return role === 'owner' || role === 'admin'
}

function denied(): ApiError {
  return new ApiError(
    403,
    'Access denied',
    'access_denied',
    'Only owners and admins manage approvals.',
  )
}

function conflict(error: AgentWorkflowConflictError): ApiError {
  const status = error.code === 'approval_role_required' ? 403 : 409
  return new ApiError(
    status,
    status === 403 ? 'Access denied' : 'Workflow conflict',
    error.code,
    error.message,
  )
}

function toApproval(row: ApprovalRequestRecord): ApprovalRequest {
  return {
    id: row.id,
    planId: row.planId,
    planHash: row.planHash,
    state: row.state,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
  }
}

function toPlan(row: AgentPlanRecord): AgentPlan {
  return {
    id: row.id,
    runId: row.runId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    hash: row.planHash,
    summary: row.summary,
    riskClass: row.riskClass,
    reversibility: row.reversibility,
    requiredRole: row.requiredRole,
    calls: row.toolCalls,
    targets: row.targetSnapshot,
    budget: row.budget,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

function toRun(row: AgentRunRecord): AgentRun {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    state: row.state,
    request: row.request,
    provider: row.provider,
    model: row.model,
    budget: row.budget,
    stepsUsed: row.stepsUsed,
    tokensUsed: row.tokensUsed,
    costMicroUsd: row.costMicroUsd,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  }
}

export class AgentWorkflowService {
  constructor(
    private readonly repository: SqliteAgentWorkflowRepository,
    private readonly projects: ProjectService,
  ) {}

  listApprovals(actorId: string, scope: TenantScope, now = new Date()): AgentApprovalInbox {
    this.authorize(actorId, scope)
    return {
      items: this.repository.listActionableApprovals(scope, now).map((approval) => {
        const plan = this.repository.findPlan(scope, approval.planId)
        const run = plan ? this.repository.findRun(scope, plan.runId) : null
        if (!plan || !run) throw new Error('Approval references an unavailable plan or run.')
        return { approval: toApproval(approval), plan: toPlan(plan), run: toRun(run) }
      }),
    }
  }

  decide(
    actorId: string,
    scope: TenantScope,
    approvalId: string,
    input: ApprovalDecisionRequest,
    requestId: string,
    now = new Date(),
  ): ApprovalRequest {
    const role = this.authorize(actorId, scope)
    try {
      return toApproval(
        this.repository.decideApproval(
          scope,
          approvalId,
          input.decision,
          { id: actorId, role },
          now,
          input.reason,
          requestId,
        ),
      )
    } catch (error) {
      if (error instanceof AgentWorkflowConflictError) throw conflict(error)
      throw error
    }
  }

  execute(
    actorId: string,
    scope: TenantScope,
    approvalId: string,
    planHash: string,
    requestId: string,
    now = new Date(),
  ): AgentRun {
    this.authorize(actorId, scope)
    try {
      const frozen = this.repository.consumeApproval(
        scope,
        approvalId,
        planHash,
        now,
        actorId,
        requestId,
      )
      const run = this.repository.findRun(scope, frozen.plan.runId)
      if (!run) throw new Error('Consumed approval references an unavailable run.')
      return toRun(run)
    } catch (error) {
      if (error instanceof AgentWorkflowConflictError) throw conflict(error)
      throw error
    }
  }

  getRun(actorId: string, scope: TenantScope, runId: string): AgentRun {
    this.authorize(actorId, scope)
    const run = this.repository.findRun(scope, runId)
    if (!run) {
      throw new ApiError(
        404,
        'Agent run not found',
        'agent_run_not_found',
        'The run does not exist.',
      )
    }
    return toRun(run)
  }

  cancelRun(
    actorId: string,
    scope: TenantScope,
    runId: string,
    input: CancelAgentRunRequest,
    requestId: string,
    now = new Date(),
  ): AgentRun {
    this.authorize(actorId, scope)
    try {
      return toRun(this.repository.cancelRun(scope, runId, actorId, now, requestId, input.reason))
    } catch (error) {
      if (error instanceof AgentWorkflowConflictError) {
        if (error.code === 'run_not_found') {
          throw new ApiError(
            404,
            'Agent run not found',
            'agent_run_not_found',
            'The run does not exist.',
          )
        }
        throw conflict(error)
      }
      throw error
    }
  }

  private authorize(actorId: string, scope: TenantScope): 'owner' | 'admin' {
    const role = this.projects.authorize(actorId, scope.organizationId, scope.projectId, 'read')
    if (!approvalAdmin(role)) throw denied()
    return role
  }
}
