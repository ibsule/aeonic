import {
  assignProjectMemberRequestSchema,
  type AssignProjectMemberRequest,
  projectMemberListSchema,
  projectMemberSchema,
} from '@aeonic/contracts'
import { Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { ApiError } from '../http/api-error.js'
import { matchesSchema, sendJson } from '../http/response.js'
import type { ProjectMemberService } from '../projects/members.js'

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function createProjectMembersRouter(
  auth: AuthService,
  projectMembers: ProjectMemberService,
): Router {
  const router = Router()
  router.use(requireUser(auth))
  const collection = '/organizations/:organizationId/projects/:projectId/members'

  router.get(collection, (request, response) => {
    const principal = getUserPrincipal(request)
    const result = projectMembers.list(
      principal.userId,
      parameter(request.params.organizationId),
      parameter(request.params.projectId),
    )
    return sendJson(response, 200, projectMemberListSchema, result)
  })

  router.post(collection, (request, response) => {
    if (
      !matchesSchema<AssignProjectMemberRequest>(assignProjectMemberRequestSchema, request.body)
    ) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The request body does not match the required contract.',
      )
    }
    const principal = getUserPrincipal(request)
    const result = projectMembers.assign(
      principal.userId,
      parameter(request.params.organizationId),
      parameter(request.params.projectId),
      request.body,
      String(request.id),
    )
    return sendJson(response, 201, projectMemberSchema, result)
  })

  router.delete(`${collection}/:userId`, (request, response) => {
    const principal = getUserPrincipal(request)
    projectMembers.remove(
      principal.userId,
      parameter(request.params.organizationId),
      parameter(request.params.projectId),
      parameter(request.params.userId),
      String(request.id),
    )
    return response.status(204).send()
  })

  return router
}
