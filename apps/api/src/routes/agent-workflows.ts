import {
  type ApprovalDecisionRequest,
  approvalDecisionRequestSchema,
  agentApprovalInboxSchema,
  agentRunSchema,
  type ConsumeApprovalRequest,
  consumeApprovalRequestSchema,
  approvalRequestSchema,
} from '@aeonic/contracts'
import { type Request, Router } from 'express'
import type { AgentWorkflowService } from '../agents/service.js'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function scope(request: Request) {
  return {
    organizationId: parameter(request, 'organizationId'),
    projectId: parameter(request, 'projectId'),
  }
}

export function createAgentWorkflowsRouter(
  auth: AuthService,
  workflows: AgentWorkflowService,
): Router {
  const router = Router()
  const base = '/organizations/:organizationId/projects/:projectId/agent-approvals'
  router.use(requireUser(auth))

  router.get(base, (request, response) => {
    response.set('cache-control', 'no-store')
    return sendJson(
      response,
      200,
      agentApprovalInboxSchema,
      workflows.listApprovals(getUserPrincipal(request).userId, scope(request)),
    )
  })

  router.post(`${base}/:approvalId/decision`, (request, response) => {
    if (!matchesSchema<ApprovalDecisionRequest>(approvalDecisionRequestSchema, request.body)) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The approval decision is invalid.',
      )
    }
    return sendJson(
      response,
      200,
      approvalRequestSchema,
      workflows.decide(
        getUserPrincipal(request).userId,
        scope(request),
        parameter(request, 'approvalId'),
        request.body,
        String(request.id),
      ),
    )
  })

  router.post(`${base}/:approvalId/execute`, (request, response) => {
    if (!matchesSchema<ConsumeApprovalRequest>(consumeApprovalRequestSchema, request.body)) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The execution request is invalid.',
      )
    }
    return sendJson(
      response,
      202,
      agentRunSchema,
      workflows.execute(
        getUserPrincipal(request).userId,
        scope(request),
        parameter(request, 'approvalId'),
        request.body.planHash,
        String(request.id),
      ),
    )
  })

  return router
}
