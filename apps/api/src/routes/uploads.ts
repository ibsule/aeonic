import { simpleUploadResultSchema, type UploadQuery, uploadQuerySchema } from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { matchesSchema, sendJson } from '../http/response.js'
import type { UploadService } from '../uploads/service.js'
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

export function createUploadsRouter(auth: AuthService, uploads: UploadService): Router {
  const router = Router()
  router.post(
    '/organizations/:organizationId/projects/:projectId/uploads',
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
          scope: {
            organizationId: parameter(request, 'organizationId'),
            projectId: parameter(request, 'projectId'),
          },
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
  return router
}
