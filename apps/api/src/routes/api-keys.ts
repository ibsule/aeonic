import {
  apiKeyListSchema,
  createApiKeyRequestSchema,
  type CreateApiKeyRequest,
  createdApiKeySchema,
} from '@aeonic/contracts'
import { Router } from 'express'
import type { ApiKeyService } from '../api-keys/service.js'
import type { AuthService } from '../auth/auth.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { ApiError } from '../http/api-error.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function createApiKeysRouter(auth: AuthService, apiKeys: ApiKeyService): Router {
  const router = Router()
  router.use(requireUser(auth))

  router.get('/organizations/:organizationId/projects/:projectId/api-keys', (request, response) => {
    const principal = getUserPrincipal(request)
    const result = apiKeys.list(
      principal.userId,
      parameter(request.params.organizationId),
      parameter(request.params.projectId),
    )
    return sendJson(response, 200, apiKeyListSchema, result)
  })

  router.post(
    '/organizations/:organizationId/projects/:projectId/api-keys',
    async (request, response) => {
      if (!matchesSchema<CreateApiKeyRequest>(createApiKeyRequestSchema, request.body)) {
        throw new ApiError(
          400,
          'Invalid request',
          'invalid_request',
          'The request body does not match the required contract.',
        )
      }
      const principal = getUserPrincipal(request)
      const result = await apiKeys.create(
        principal.userId,
        parameter(request.params.organizationId),
        parameter(request.params.projectId),
        request.body,
        String(request.id),
      )
      return sendJson(response, 201, createdApiKeySchema, result)
    },
  )

  router.delete(
    '/organizations/:organizationId/projects/:projectId/api-keys/:keyId',
    (request, response) => {
      const principal = getUserPrincipal(request)
      apiKeys.revoke(
        principal.userId,
        parameter(request.params.organizationId),
        parameter(request.params.projectId),
        parameter(request.params.keyId),
        String(request.id),
      )
      return response.status(204).send()
    },
  )

  return router
}
