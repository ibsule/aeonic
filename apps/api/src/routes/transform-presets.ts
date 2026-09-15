import {
  type CreateTransformPresetRequest,
  type CreateTransformPresetVersionRequest,
  createTransformPresetRequestSchema,
  createTransformPresetVersionRequestSchema,
  transformPresetListSchema,
  transformPresetSchema,
} from '@aeonic/contracts'
import { type Request, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'
import type { TransformPresetService } from '../transforms/presets.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function requireBody<T>(schema: object, body: unknown): T {
  if (!matchesSchema<T>(schema, body)) {
    throw new ApiError(
      400,
      'Invalid request',
      'invalid_request',
      'The request body does not match the required contract.',
    )
  }
  return body
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

export function createTransformPresetsRouter(
  auth: AuthService,
  presets: TransformPresetService,
): Router {
  const router = Router()
  router.use(requireUser(auth))
  const collection = '/organizations/:organizationId/projects/:projectId/transform-presets'

  router.get(collection, (request, response) => {
    const principal = getUserPrincipal(request)
    const cursor = optionalQuery(request.query.cursor)
    const result = presets.list(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      {
        ...(cursor ? { cursor } : {}),
        limit: limitFrom(request.query.limit),
      },
    )
    return sendJson(response, 200, transformPresetListSchema, result)
  })

  router.post(collection, (request, response) => {
    const principal = getUserPrincipal(request)
    const input = requireBody<CreateTransformPresetRequest>(
      createTransformPresetRequestSchema,
      request.body,
    )
    const result = presets.create(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      input,
      String(request.id),
    )
    response.location(`${request.baseUrl}${request.path}/${result.name}/versions/${result.version}`)
    return sendJson(response, 201, transformPresetSchema, result)
  })

  router.post(`${collection}/:name/versions`, (request, response) => {
    const principal = getUserPrincipal(request)
    const input = requireBody<CreateTransformPresetVersionRequest>(
      createTransformPresetVersionRequestSchema,
      request.body,
    )
    const result = presets.createVersion(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      parameter(request, 'name'),
      input,
      String(request.id),
    )
    response.location(
      `${request.baseUrl}${collection
        .replace(':organizationId', result.organizationId)
        .replace(':projectId', result.projectId)}/${result.name}/versions/${result.version}`,
    )
    return sendJson(response, 201, transformPresetSchema, result)
  })

  router.get(`${collection}/:name/versions/:version`, (request, response) => {
    const principal = getUserPrincipal(request)
    const result = presets.get(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      parameter(request, 'name'),
      parameter(request, 'version'),
    )
    return sendJson(response, 200, transformPresetSchema, result)
  })

  return router
}
