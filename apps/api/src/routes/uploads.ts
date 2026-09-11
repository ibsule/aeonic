import { simpleUploadResultSchema, type UploadQuery, uploadQuerySchema } from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'
import type { UploadService } from '../uploads/service.js'
import {
  parseTusChecksum,
  parseTusInteger,
  parseTusMetadata,
  requireTusVersion,
  tusChecksumAlgorithms,
  tusExtensions,
  tusVersion,
} from '../uploads/tus-protocol.js'
import type { TusUploadService, TusUploadStatus } from '../uploads/tus-service.js'
import { parseContentDigest, validateUploadDescriptor } from '../uploads/validation.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function uploadQuery(request: Request): UploadQuery {
  const value: Record<string, string> = {}
  for (const [name, item] of Object.entries(request.query)) {
    if (typeof item !== 'string') {
      throw new ApiError(
        400,
        'Invalid upload',
        'invalid_upload_query',
        'Upload query parameters must each contain one string value.',
      )
    }
    value[name] = item
  }
  if (!matchesSchema<UploadQuery>(uploadQuerySchema, value)) {
    throw new ApiError(
      400,
      'Invalid upload',
      'invalid_upload_query',
      'The upload query does not match the required contract.',
    )
  }
  return value
}

function contentLength(request: Request): number {
  const header = request.get('content-length')
  if (header === undefined) {
    throw new ApiError(
      411,
      'Content length required',
      'content_length_required',
      'Simple uploads require an exact Content-Length header.',
    )
  }
  const value = Number(header)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(
      400,
      'Invalid content length',
      'invalid_content_length',
      'Content-Length must be a positive integer.',
    )
  }
  return value
}

function idempotencyKey(request: Request): string | undefined {
  const value = request.get('idempotency-key')
  if (value === undefined) return undefined
  if (!/^[\x21-\x7e]{8,128}$/.test(value)) {
    throw new ApiError(
      400,
      'Invalid idempotency key',
      'invalid_idempotency_key',
      'Idempotency-Key must contain 8 to 128 visible ASCII characters.',
    )
  }
  return value
}

function setTusHeader(response: Response): void {
  response.set({
    'tus-resumable': tusVersion,
    'tus-version': tusVersion,
    'cache-control': 'no-store',
  })
}

function setTusDiscoveryHeaders(response: Response, maxBytes: number): void {
  response.set({
    'tus-resumable': tusVersion,
    'tus-version': tusVersion,
    'tus-extension': tusExtensions,
    'tus-max-size': String(maxBytes),
    'tus-checksum-algorithm': tusChecksumAlgorithms,
    'cache-control': 'no-store',
  })
}

function setTusStatusHeaders(response: Response, status: TusUploadStatus): void {
  response.set({
    'upload-offset': String(status.offset),
    'upload-length': String(status.length),
    'upload-metadata': status.metadata,
    'upload-asset-id': status.assetId,
    'upload-public-id': status.publicId,
    ...(status.expiresAt === null ? {} : { 'upload-expires': status.expiresAt.toUTCString() }),
  })
}

function scope(request: Request) {
  return {
    organizationId: parameter(request, 'organizationId'),
    projectId: parameter(request, 'projectId'),
  }
}

export function createUploadsRouter(
  auth: AuthService,
  uploads: UploadService,
  tus: TusUploadService,
  tusMaxBytes: number,
): Router {
  const router = Router()
  const simpleCollection = '/organizations/:organizationId/projects/:projectId/uploads'
  const tusCollection = '/organizations/:organizationId/projects/:projectId/tus'
  const item = `${tusCollection}/:uploadId`
  const requireCreate = requireProjectActor(auth, { resource: 'asset', action: 'create' })

  router.options([tusCollection, item], (_request: Request, response: Response) => {
    setTusDiscoveryHeaders(response, tusMaxBytes)
    response.status(204).end()
  })

  router.post(
    tusCollection,
    (_request, response, next) => {
      setTusHeader(response)
      next()
    },
    requireCreate,
    async (request: Request, response: Response) => {
      requireTusVersion(request.get('tus-resumable'))
      const declaredRequestBytes = request.get('content-length')
      if (
        (declaredRequestBytes !== undefined && declaredRequestBytes !== '0') ||
        request.get('transfer-encoding') !== undefined
      ) {
        request.resume()
        throw new ApiError(
          415,
          'Creation with upload is unsupported',
          'creation_with_upload_unsupported',
          'Create the upload with an empty POST, then transfer bytes using PATCH.',
        )
      }
      const principal = request.principal
      if (!principal) throw new Error('Authenticated tus route is missing a principal')
      const created = await tus.create({
        principal,
        scope: scope(request),
        metadata: parseTusMetadata(request.get('upload-metadata')),
        length: parseTusInteger(request.get('upload-length'), 'Upload-Length'),
        requestId: String(request.id),
      })
      const location = `${request.baseUrl}${tusCollection
        .replace(':organizationId', scope(request).organizationId)
        .replace(':projectId', scope(request).projectId)}/${created.uploadId}`
      response.set({
        location,
        'upload-expires': created.expiresAt.toUTCString(),
        'upload-offset': '0',
        'upload-asset-id': created.assetId,
        'upload-public-id': created.publicId,
      })
      response.status(201).end()
    },
  )

  router.post(
    simpleCollection,
    requireProjectActor(auth, { resource: 'asset', action: 'create' }),
    async (request: Request, response: Response) => {
      const principal = request.principal
      if (!principal) throw new Error('Authenticated upload route is missing a principal')
      const descriptor = validateUploadDescriptor(uploadQuery(request), request.get('content-type'))
      const expectedSha256 = parseContentDigest(request.get('content-digest'))
      const requestIdempotencyKey = idempotencyKey(request)
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      request.once('aborted', abort)
      response.once('close', () => {
        if (!response.writableEnded) abort()
      })

      try {
        const outcome = await uploads.create({
          principal,
          scope: scope(request),
          descriptor,
          contentLength: contentLength(request),
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(requestIdempotencyKey === undefined ? {} : { idempotencyKey: requestIdempotencyKey }),
          requestId: String(request.id),
          source: request,
          signal: controller.signal,
        })
        response.set('cache-control', 'no-store')
        if (outcome.replayed) response.set('idempotency-replayed', 'true')
        sendJson(response, outcome.replayed ? 200 : 201, simpleUploadResultSchema, outcome.result)
      } finally {
        request.off('aborted', abort)
      }
    },
  )

  const markTus = (_request: Request, response: Response, next: () => void): void => {
    setTusHeader(response)
    next()
  }

  router.head(item, markTus, requireCreate, async (request: Request, response: Response) => {
    requireTusVersion(request.get('tus-resumable'))
    const principal = request.principal
    if (!principal) throw new Error('Authenticated tus route is missing a principal')
    const status = await tus.status({
      principal,
      scope: scope(request),
      uploadId: parameter(request, 'uploadId'),
      requestId: String(request.id),
    })
    setTusStatusHeaders(response, status)
    response.status(200).end()
  })

  router.patch(item, markTus, requireCreate, async (request: Request, response: Response) => {
    requireTusVersion(request.get('tus-resumable'))
    if (request.get('content-type')?.toLowerCase() !== 'application/offset+octet-stream') {
      request.resume()
      throw new ApiError(
        415,
        'Unsupported media type',
        'invalid_tus_content_type',
        'Tus PATCH requests require Content-Type: application/offset+octet-stream.',
      )
    }
    const principal = request.principal
    if (!principal) throw new Error('Authenticated tus route is missing a principal')
    const declaredLength = request.get('content-length')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    request.once('aborted', abort)
    response.once('close', () => {
      if (!response.writableEnded) abort()
    })
    try {
      const status = await tus.append({
        principal,
        scope: scope(request),
        uploadId: parameter(request, 'uploadId'),
        offset: parseTusInteger(request.get('upload-offset'), 'Upload-Offset'),
        ...(declaredLength === undefined
          ? {}
          : { contentLength: parseTusInteger(declaredLength, 'Content-Length') }),
        ...(request.get('upload-checksum') === undefined
          ? {}
          : {
              checksum: parseTusChecksum(request.get('upload-checksum')) as NonNullable<
                ReturnType<typeof parseTusChecksum>
              >,
            }),
        requestId: String(request.id),
        source: request,
        signal: controller.signal,
      })
      setTusStatusHeaders(response, status)
      response.status(204).end()
    } finally {
      request.off('aborted', abort)
    }
  })

  router.delete(item, markTus, requireCreate, async (request: Request, response: Response) => {
    requireTusVersion(request.get('tus-resumable'))
    const principal = request.principal
    if (!principal) throw new Error('Authenticated tus route is missing a principal')
    await tus.terminate({
      principal,
      scope: scope(request),
      uploadId: parameter(request, 'uploadId'),
      requestId: String(request.id),
    })
    response.status(204).end()
  })
  return router
}
