import { pipeline } from 'node:stream/promises'
import {
  type CreateDerivativeRequest,
  createDerivativeRequestSchema,
  derivativeSchema,
} from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import { validate as isUuid } from 'uuid'
import type { AuthService } from '../auth/auth.js'
import type { AsyncDerivativeService } from '../derivatives/async-service.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function uuidParameter(request: Request, name: string): string {
  const value = parameter(request, name)
  if (!isUuid(value)) {
    throw new ApiError(400, 'Invalid identifier', 'invalid_identifier', `${name} must be a UUID.`)
  }
  return value
}

function versionParameter(request: Request): number {
  const raw = parameter(request, 'version')
  const version = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(
      400,
      'Invalid version',
      'invalid_version',
      'Version must be a positive integer.',
    )
  }
  return version
}

function principal(request: Request) {
  if (!request.principal) throw new Error('Authenticated derivative route is missing a principal')
  return request.principal
}

export function createDerivativesRouter(
  auth: AuthService,
  service: AsyncDerivativeService,
): Router {
  const router = Router()
  const assetCollection =
    '/organizations/:organizationId/projects/:projectId/assets/:publicId/versions/:version/derivatives'
  const derivativeItem =
    '/organizations/:organizationId/projects/:projectId/derivatives/:derivativeId'
  const read = requireProjectActor(auth, { resource: 'asset', action: 'read' })
  const write = requireProjectActor(auth, { resource: 'asset', action: 'update' })

  router.post(assetCollection, write, (request, response) => {
    if (!matchesSchema<CreateDerivativeRequest>(createDerivativeRequestSchema, request.body)) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The request body does not match the required contract.',
      )
    }
    const scope = {
      organizationId: uuidParameter(request, 'organizationId'),
      projectId: uuidParameter(request, 'projectId'),
    }
    const result = service.create(
      principal(request),
      scope,
      uuidParameter(request, 'publicId'),
      versionParameter(request),
      request.body,
      String(request.id),
    )
    response.location(
      `${request.baseUrl}/organizations/${scope.organizationId}/projects/${scope.projectId}/derivatives/${result.id}`,
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, result.state === 'ready' ? 200 : 202, derivativeSchema, result)
  })

  router.get(derivativeItem, read, (request, response) => {
    const result = service.get(
      principal(request),
      {
        organizationId: uuidParameter(request, 'organizationId'),
        projectId: uuidParameter(request, 'projectId'),
      },
      uuidParameter(request, 'derivativeId'),
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, 200, derivativeSchema, result)
  })

  const content = async (request: Request, response: Response): Promise<void> => {
    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const result = await service.open(
      principal(request),
      {
        organizationId: uuidParameter(request, 'organizationId'),
        projectId: uuidParameter(request, 'projectId'),
      },
      uuidParameter(request, 'derivativeId'),
      controller.signal,
    )
    response.set({
      'cache-control': 'private, no-store',
      'content-type': result.derivative.mimeType as string,
      'content-length': String(result.derivative.sizeBytes),
      etag: `"${result.derivative.sha256}"`,
      'x-content-type-options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      response.status(200).end()
      return
    }
    response.status(200)
    await pipeline(result.source, response, { signal: controller.signal })
  }
  router.get(`${derivativeItem}/content`, read, content)
  router.head(`${derivativeItem}/content`, read, content)
  return router
}
