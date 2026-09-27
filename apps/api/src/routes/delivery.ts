import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  type CreateDeliveryUrlRequest,
  createDeliveryUrlRequestSchema,
  type DeliveryDisposition,
  deliveryUrlSchema,
} from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import { validate as isUuid } from 'uuid'
import type { AuthService } from '../auth/auth.js'
import type { AppConfig } from '../config.js'
import {
  contentDisposition,
  InvalidRangeError,
  ifModifiedSinceMatches,
  ifNoneMatchMatches,
  ifRangeAllows,
  parseSingleByteRange,
} from '../delivery/http.js'
import {
  type DeliveryService,
  effectiveDisposition,
  type OriginalAsset,
  type SignedDeliveryQuery,
} from '../delivery/service.js'
import { createOriginalDeliveryPath, createTransformDeliveryPath } from '../delivery/signing.js'
import { resolveImageOutputFormat } from '../derivatives/output-format.js'
import {
  DerivativeGenerationPendingError,
  type ImageDerivative,
  type ImageDerivativeService,
} from '../derivatives/service.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { sendProblem } from '../http/problem.js'
import { matchesSchema, sendJson } from '../http/response.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function versionParameter(request: Request, publicRoute: boolean): number {
  const raw = parameter(request, 'version')
  const version = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(version) || version < 1) {
    throw publicRoute
      ? new ApiError(
          404,
          'Asset not found',
          'asset_not_found',
          'The requested asset is not available.',
        )
      : new ApiError(
          400,
          'Invalid version',
          'invalid_version',
          'Version must be a positive integer.',
        )
  }
  return version
}

function assertUuidParameter(request: Request, name: string, publicRoute: boolean): string {
  const value = parameter(request, name)
  if (!isUuid(value)) {
    throw publicRoute
      ? new ApiError(
          404,
          'Asset not found',
          'asset_not_found',
          'The requested asset is not available.',
        )
      : new ApiError(400, 'Invalid identifier', 'invalid_identifier', `${name} must be a UUID.`)
  }
  return value
}

function queryStrings(request: Request, allowed: ReadonlySet<string>, publicRoute: boolean) {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.query)) {
    if (!allowed.has(name) || typeof value !== 'string') {
      throw publicRoute
        ? new ApiError(
            404,
            'Asset not found',
            'asset_not_found',
            'The requested asset is not available.',
          )
        : new ApiError(
            400,
            'Invalid delivery query',
            'invalid_delivery_query',
            'The delivery query is invalid.',
          )
    }
    result[name] = value
  }
  return result
}

function requestedDisposition(value: string | undefined): DeliveryDisposition | undefined {
  if (value === undefined) return undefined
  if (value !== 'inline' && value !== 'attachment') {
    throw new ApiError(
      400,
      'Invalid disposition',
      'invalid_disposition',
      'Disposition must be inline or attachment.',
    )
  }
  return value
}

function publicAuthorization(
  request: Request,
  asset: OriginalAsset,
): { disposition: DeliveryDisposition; signed: SignedDeliveryQuery | null } {
  const query = queryStrings(request, new Set(['disposition', 'expires', 'kid', 'signature']), true)
  let requested: DeliveryDisposition | undefined
  try {
    requested = requestedDisposition(query.disposition)
  } catch {
    throw new ApiError(
      404,
      'Asset not found',
      'asset_not_found',
      'The requested asset is not available.',
    )
  }
  const disposition = effectiveDisposition(asset.mediaKind, requested)
  if (requested !== undefined && requested !== disposition) {
    throw new ApiError(
      404,
      'Asset not found',
      'asset_not_found',
      'The requested asset is not available.',
    )
  }
  const signatureFields = [query.expires, query.kid, query.signature]
  if (signatureFields.every((value) => value === undefined)) return { disposition, signed: null }
  if (signatureFields.some((value) => value === undefined) || !/^\d+$/.test(query.expires ?? '')) {
    throw new ApiError(
      404,
      'Asset not found',
      'asset_not_found',
      'The requested asset is not available.',
    )
  }
  return {
    disposition,
    signed: {
      disposition,
      expires: Number(query.expires),
      keyId: query.kid as string,
      signature: query.signature as string,
    },
  }
}

function cacheControl(publicCache: boolean, seconds: number): string {
  return publicCache ? `public, max-age=${seconds}, immutable` : 'private, no-store'
}

function publicNotFound(): ApiError {
  return new ApiError(
    404,
    'Asset not found',
    'asset_not_found',
    'The requested asset is not available.',
  )
}

function setValidatorHeaders(
  response: Response,
  asset: Pick<OriginalAsset, 'sha256' | 'finalizedAt'>,
  cacheValue: string,
  publicRoute: boolean,
): void {
  response.set({
    'accept-ranges': 'bytes',
    'cache-control': cacheValue,
    etag: `"${asset.sha256}"`,
    'last-modified': asset.finalizedAt.toUTCString(),
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': publicRoute ? 'cross-origin' : 'same-origin',
  })
}

interface DeliverableAsset {
  readonly sha256: string
  readonly finalizedAt: Date
  readonly sizeBytes: number
  readonly mimeType: string
  readonly filename: string
}

async function sendAsset(
  request: Request,
  response: Response,
  asset: DeliverableAsset,
  open: (
    range: { start: number; end: number } | undefined,
    signal: AbortSignal,
  ) => Promise<Readable>,
  disposition: DeliveryDisposition,
  publicCache: boolean,
  publicRoute: boolean,
  config: Pick<AppConfig, 'publicDeliveryCacheSeconds'>,
): Promise<void> {
  const etag = `"${asset.sha256}"`
  const cacheValue = cacheControl(publicCache, config.publicDeliveryCacheSeconds)
  setValidatorHeaders(response, asset, cacheValue, publicRoute)

  const ifNoneMatch = request.get('if-none-match')
  if (
    ifNoneMatchMatches(ifNoneMatch, etag) ||
    (ifNoneMatch === undefined &&
      ifModifiedSinceMatches(request.get('if-modified-since'), asset.finalizedAt))
  ) {
    response.status(304).end()
    return
  }

  let range: { start: number; end: number } | undefined
  if (
    request.method === 'GET' &&
    request.get('range') !== undefined &&
    ifRangeAllows(request.get('if-range'), etag, asset.finalizedAt)
  ) {
    try {
      range = parseSingleByteRange(request.get('range') as string, asset.sizeBytes)
    } catch (error) {
      if (!(error instanceof InvalidRangeError)) throw error
      response.set('content-range', `bytes */${asset.sizeBytes}`)
      response.set('cache-control', 'no-store')
      sendProblem(request, response, {
        status: 416,
        title: 'Range Not Satisfiable',
        code: 'range_not_satisfiable',
        detail: error.message,
      })
      return
    }
  }

  const sizeBytes = range ? range.end - range.start + 1 : asset.sizeBytes
  response.set({
    'content-type': asset.mimeType,
    'content-length': String(sizeBytes),
    'content-disposition': contentDisposition(disposition, asset.filename),
  })
  if (range) response.set('content-range', `bytes ${range.start}-${range.end}/${asset.sizeBytes}`)
  const status = range ? 206 : 200
  if (request.method === 'HEAD') {
    response.status(status).end()
    return
  }

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  response.once('close', () => {
    if (!response.writableEnded) abort()
  })
  const source = await open(range, controller.signal)
  response.status(status)
  try {
    await pipeline(source, response, { signal: controller.signal })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  }
}

export function createDeliveryRouter(
  auth: AuthService,
  delivery: DeliveryService,
  derivatives: ImageDerivativeService,
  config: AppConfig,
): Router {
  const router = Router()
  const authenticatedOriginalPath =
    '/api/v1/organizations/:organizationId/projects/:projectId/assets/:publicId/versions/:version/original'
  const deliveryUrlPath =
    '/api/v1/organizations/:organizationId/projects/:projectId/assets/:publicId/versions/:version/delivery-url'
  const requireRead = requireProjectActor(auth, { resource: 'asset', action: 'read' })

  router.post(deliveryUrlPath, requireRead, (request: Request, response: Response) => {
    if (!matchesSchema<CreateDeliveryUrlRequest>(createDeliveryUrlRequestSchema, request.body)) {
      throw new ApiError(
        400,
        'Invalid request',
        'invalid_request',
        'The request body does not match the required contract.',
      )
    }
    const principal = request.principal
    if (!principal) throw new Error('Authenticated delivery route is missing a principal')
    const scope = {
      organizationId: assertUuidParameter(request, 'organizationId', false),
      projectId: assertUuidParameter(request, 'projectId', false),
    }
    const asset = delivery.findForProject(
      scope,
      assertUuidParameter(request, 'publicId', false),
      versionParameter(request, false),
    )
    const result = delivery.createSignedUrl(principal, asset, request.body, String(request.id))
    response.set('cache-control', 'no-store')
    return sendJson(response, 201, deliveryUrlSchema, result)
  })

  const authenticatedHandler = async (request: Request, response: Response): Promise<void> => {
    const principal = request.principal
    if (!principal) throw new Error('Authenticated delivery route is missing a principal')
    const query = queryStrings(request, new Set(['disposition']), false)
    const scope = {
      organizationId: assertUuidParameter(request, 'organizationId', false),
      projectId: assertUuidParameter(request, 'projectId', false),
    }
    const asset = delivery.findForProject(
      scope,
      assertUuidParameter(request, 'publicId', false),
      versionParameter(request, false),
    )
    delivery.authorize(principal, asset)
    await sendAsset(
      request,
      response,
      asset,
      (range, signal) => delivery.open(asset, range, signal),
      effectiveDisposition(asset.mediaKind, requestedDisposition(query.disposition)),
      false,
      false,
      config,
    )
  }
  router.get(authenticatedOriginalPath, requireRead, authenticatedHandler)
  router.head(authenticatedOriginalPath, requireRead, authenticatedHandler)

  const publicHandler = async (request: Request, response: Response): Promise<void> => {
    const projectId = assertUuidParameter(request, 'projectId', true)
    const publicId = assertUuidParameter(request, 'publicId', true)
    const version = versionParameter(request, true)
    const asset = delivery.findForPublicPath(projectId, publicId, version)
    const filename = parameter(request, 'filename')
    if (filename !== asset.filename) {
      throw new ApiError(
        404,
        'Asset not found',
        'asset_not_found',
        'The requested asset is not available.',
      )
    }
    const authorization = publicAuthorization(request, asset)
    const path = createOriginalDeliveryPath({ projectId, publicId, version, filename })
    if (!delivery.isPubliclyAuthorized(asset, path, authorization.signed)) {
      throw new ApiError(
        404,
        'Asset not found',
        'asset_not_found',
        'The requested asset is not available.',
      )
    }
    await sendAsset(
      request,
      response,
      asset,
      (range, signal) => delivery.open(asset, range, signal),
      authorization.disposition,
      asset.visibility === 'public' && authorization.signed === null,
      true,
      config,
    )
  }
  router.get('/m/:projectId/:publicId/v:version/original/:filename', publicHandler)
  router.head('/m/:projectId/:publicId/v:version/original/:filename', publicHandler)

  const transformedFilename = (filename: string, derivative: ImageDerivative): string => {
    const extension = derivative.outputFormat === 'jpeg' ? 'jpg' : derivative.outputFormat
    const separator = filename.lastIndexOf('.')
    return `${separator > 0 ? filename.slice(0, separator) : filename}.${extension}`
  }

  const serveTransform = async (
    request: Request,
    response: Response,
    asset: OriginalAsset,
    publicRoute: boolean,
    disposition: DeliveryDisposition,
    publicCache: boolean,
  ): Promise<void> => {
    const specification = parameter(request, 'transformSpec')
    const transform = delivery.resolveTransform(asset, specification)
    if (!specification.startsWith('p_') && specification !== transform.canonicalSpec) {
      throw publicRoute
        ? publicNotFound()
        : new ApiError(
            400,
            'Non-canonical transform',
            'non_canonical_transform',
            'Use the canonical transform specification.',
          )
    }
    const outputFormat = resolveImageOutputFormat(
      transform.plan.format,
      asset.mimeType,
      request.get('accept'),
    )
    if (!outputFormat) {
      throw new ApiError(
        406,
        'Not Acceptable',
        'image_format_not_acceptable',
        'No supported derivative format is acceptable to the client.',
      )
    }
    let derivative: ImageDerivative
    try {
      derivative = await derivatives.resolve(
        asset,
        transform,
        outputFormat,
        `request:${String(request.id)}`,
      )
    } catch (error) {
      if (!(error instanceof DerivativeGenerationPendingError)) throw error
      response.set('retry-after', '1')
      throw new ApiError(
        503,
        'Derivative pending',
        'derivative_generation_pending',
        'The derivative is already being generated. Retry shortly.',
      )
    }
    if (transform.plan.format === 'auto') response.vary('Accept')
    await sendAsset(
      request,
      response,
      { ...derivative, filename: transformedFilename(asset.filename, derivative) },
      (range, signal) => derivatives.open(derivative, range, signal),
      disposition,
      publicCache,
      publicRoute,
      config,
    )
  }

  const authenticatedTransformPath =
    '/api/v1/organizations/:organizationId/projects/:projectId/assets/:publicId/versions/:version/t/:transformSpec'
  const authenticatedTransform = async (request: Request, response: Response): Promise<void> => {
    const principal = request.principal
    if (!principal) throw new Error('Authenticated delivery route is missing a principal')
    const query = queryStrings(request, new Set(['disposition']), false)
    const scope = {
      organizationId: assertUuidParameter(request, 'organizationId', false),
      projectId: assertUuidParameter(request, 'projectId', false),
    }
    const asset = delivery.findForProject(
      scope,
      assertUuidParameter(request, 'publicId', false),
      versionParameter(request, false),
    )
    delivery.authorize(principal, asset)
    await serveTransform(
      request,
      response,
      asset,
      false,
      effectiveDisposition(asset.mediaKind, requestedDisposition(query.disposition)),
      false,
    )
  }
  router.get(authenticatedTransformPath, requireRead, authenticatedTransform)
  router.head(authenticatedTransformPath, requireRead, authenticatedTransform)

  const publicTransform = async (request: Request, response: Response): Promise<void> => {
    const projectId = assertUuidParameter(request, 'projectId', true)
    const publicId = assertUuidParameter(request, 'publicId', true)
    const version = versionParameter(request, true)
    const asset = delivery.findForPublicPath(projectId, publicId, version)
    if (parameter(request, 'filename') !== asset.filename) throw publicNotFound()
    const authorization = publicAuthorization(request, asset)
    let transform: ReturnType<DeliveryService['resolveTransform']>
    try {
      transform = delivery.resolveTransform(asset, parameter(request, 'transformSpec'))
    } catch {
      throw publicNotFound()
    }
    const path = createTransformDeliveryPath({
      projectId,
      publicId,
      version,
      canonicalSpec: transform.canonicalSpec,
      filename: asset.filename,
    })
    if (!delivery.isPubliclyAuthorized(asset, path, authorization.signed)) throw publicNotFound()
    await serveTransform(
      request,
      response,
      asset,
      true,
      authorization.disposition,
      asset.visibility === 'public' && authorization.signed === null,
    )
  }
  router.get('/m/:projectId/:publicId/v:version/t/:transformSpec/:filename', publicTransform)
  router.head('/m/:projectId/:publicId/v:version/t/:transformSpec/:filename', publicTransform)

  return router
}
