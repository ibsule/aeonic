import { auditEventListSchema } from '@aeonic/contracts'
import { Router } from 'express'
import type { AuditService } from '../audit/service.js'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { sendJson } from '../http/response.js'

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function optionalQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function limitFrom(value: unknown): number {
  if (value === undefined) return 50
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be an integer.')
  }
  const limit = Number(value)
  if (limit < 1 || limit > 100) {
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be between 1 and 100.')
  }
  return limit
}

export function createAuditEventsRouter(auth: AuthService, audit: AuditService): Router {
  const router = Router()
  router.use(requireUser(auth))

  router.get('/organizations/:organizationId/audit-events', (request, response) => {
    const principal = getUserPrincipal(request)
    const projectId = optionalQuery(request.query.projectId)
    const cursor = optionalQuery(request.query.cursor)
    const result = audit.list(principal.userId, parameter(request.params.organizationId), {
      ...(projectId ? { projectId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: limitFrom(request.query.limit),
    })
    return sendJson(response, 200, auditEventListSchema, result)
  })

  return router
}
