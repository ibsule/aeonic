import {
  aiIndexSchema,
  type StartSemanticReindexRequest,
  semanticSearchResponseSchema,
  semanticSearchSettingsSchema,
  startSemanticReindexRequestSchema,
  type UpdateAssetAiExclusionRequest,
  type UpdateSemanticSearchSettingsRequest,
  updateAssetAiExclusionRequestSchema,
  updateSemanticSearchSettingsRequestSchema,
} from '@aeonic/contracts'
import { type Request, Router } from 'express'
import type { SemanticSearchService } from '../ai/service.js'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor, requireUser } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function principal(request: Request) {
  if (!request.principal) throw new Error('Authenticated semantic route is missing a principal')
  return request.principal
}

function scope(request: Request) {
  return {
    organizationId: parameter(request, 'organizationId'),
    projectId: parameter(request, 'projectId'),
  }
}

function limit(value: unknown): number {
  if (value === undefined) return 20
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be an integer.')
  }
  const parsed = Number(value)
  if (parsed < 1 || parsed > 100) {
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be between 1 and 100.')
  }
  return parsed
}

export function createSemanticSearchRouter(
  auth: AuthService,
  semantic: SemanticSearchService,
): Router {
  const router = Router()
  const base = '/organizations/:organizationId/projects/:projectId'
  const read = requireProjectActor(auth, { resource: 'asset', action: 'read' })
  const manage = requireUser(auth)

  router.get(`${base}/semantic/settings`, read, (request, response) => {
    response.set('cache-control', 'no-store')
    return sendJson(
      response,
      200,
      semanticSearchSettingsSchema,
      semantic.settings(principal(request), scope(request)),
    )
  })

  router.patch(`${base}/semantic/settings`, manage, (request, response) => {
    if (
      !matchesSchema<UpdateSemanticSearchSettingsRequest>(
        updateSemanticSearchSettingsRequestSchema,
        request.body,
      )
    ) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The semantic-search settings do not match the required contract.',
      )
    }
    response.set('cache-control', 'no-store')
    return sendJson(
      response,
      200,
      semanticSearchSettingsSchema,
      semantic.updateSettings(principal(request), scope(request), request.body, String(request.id)),
    )
  })

  router.post(`${base}/semantic/reindex`, manage, (request, response) => {
    if (
      !matchesSchema<StartSemanticReindexRequest>(startSemanticReindexRequestSchema, request.body)
    ) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The reindex request does not match the required contract.',
      )
    }
    response.set('cache-control', 'no-store')
    return sendJson(
      response,
      202,
      aiIndexSchema,
      semantic.startReindex(principal(request), scope(request), request.body, String(request.id)),
    )
  })

  router.get(`${base}/search`, read, async (request, response) => {
    const query = request.query.query
    if (typeof query !== 'string') {
      throw new ApiError(
        400,
        'Invalid search query',
        'invalid_search_query',
        'Provide one query string.',
      )
    }
    const result = await semantic.search(
      principal(request),
      scope(request),
      query,
      limit(request.query.limit),
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, 200, semanticSearchResponseSchema, result)
  })

  router.put(`${base}/assets/:publicId/ai-exclusion`, manage, (request, response) => {
    if (
      !matchesSchema<UpdateAssetAiExclusionRequest>(
        updateAssetAiExclusionRequestSchema,
        request.body,
      )
    ) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The exclusion request does not match the required contract.',
      )
    }
    semantic.setAssetExclusion(
      principal(request),
      scope(request),
      parameter(request, 'publicId'),
      request.body.excluded,
      String(request.id),
    )
    response.status(204).end()
  })

  router.delete(`${base}/semantic/indexes/:indexId`, manage, (request, response) => {
    semantic.deleteIndex(
      principal(request),
      scope(request),
      parameter(request, 'indexId'),
      String(request.id),
    )
    response.status(204).end()
  })

  return router
}
