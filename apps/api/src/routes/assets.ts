import {
  type AssetState,
  assetListSchema,
  assetSchema,
  assetStates,
  type AssetVisibility,
  type UpdateAssetRequest,
  updateAssetRequestSchema,
} from '@aeonic/contracts'
import { type Request, Router } from 'express'
import type { AssetService } from '../assets/service.js'
import { assetEtag } from '../assets/service.js'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function optionalQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function limitFrom(value: unknown): number {
  if (value === undefined) return 50
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be an integer.')
  const limit = Number(value)
  if (limit < 1 || limit > 100)
    throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be between 1 and 100.')
  return limit
}

function principal(request: Request) {
  if (!request.principal) throw new Error('Authenticated asset route is missing a principal')
  return request.principal
}

export function createAssetsRouter(auth: AuthService, assets: AssetService): Router {
  const router = Router()
  const collection = '/organizations/:organizationId/projects/:projectId/assets'
  const item = `${collection}/:publicId`
  const read = requireProjectActor(auth, { resource: 'asset', action: 'read' })
  const write = requireProjectActor(auth, { resource: 'asset', action: 'update' })

  router.get(collection, read, (request, response) => {
    const mediaKind = optionalQuery(request.query.mediaKind)
    const state = optionalQuery(request.query.state)
    const visibility = optionalQuery(request.query.visibility)
    const cursor = optionalQuery(request.query.cursor)
    const query = optionalQuery(request.query.query)
    if (mediaKind && !['image', 'video', 'document'].includes(mediaKind))
      throw new ApiError(
        400,
        'Invalid media kind',
        'invalid_media_kind',
        'Media kind must be image, video, or document.',
      )
    if (state && !assetStates.includes(state as AssetState))
      throw new ApiError(
        400,
        'Invalid asset state',
        'invalid_asset_state',
        'The asset state is not supported.',
      )
    if (visibility && visibility !== 'private' && visibility !== 'public')
      throw new ApiError(
        400,
        'Invalid visibility',
        'invalid_visibility',
        'Visibility must be private or public.',
      )
    const result = assets.list(
      principal(request),
      {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      },
      {
        limit: limitFrom(request.query.limit),
        ...(cursor ? { cursor } : {}),
        ...(query ? { query } : {}),
        ...(mediaKind ? { mediaKind: mediaKind as 'image' | 'video' | 'document' } : {}),
        ...(state ? { state: state as AssetState } : {}),
        ...(visibility ? { visibility: visibility as AssetVisibility } : {}),
      },
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, 200, assetListSchema, result)
  })

  router.get(item, read, (request, response) => {
    const result = assets.get(
      principal(request),
      {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      },
      parameter(request, 'publicId'),
    )
    response.set({ 'cache-control': 'no-store', etag: assetEtag(result) })
    return sendJson(response, 200, assetSchema, result)
  })

  router.patch(item, write, (request, response) => {
    if (!matchesSchema<UpdateAssetRequest>(updateAssetRequestSchema, request.body))
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The request body does not match the required contract.',
      )
    const result = assets.update(
      principal(request),
      {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      },
      parameter(request, 'publicId'),
      request.get('if-match'),
      request.body,
      String(request.id),
    )
    response.set({ 'cache-control': 'no-store', etag: assetEtag(result) })
    return sendJson(response, 200, assetSchema, result)
  })

  return router
}
