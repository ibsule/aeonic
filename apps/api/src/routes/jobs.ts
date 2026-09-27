import { type JobState, jobListSchema, jobSchema, jobStates } from '@aeonic/contracts'
import { type Request, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { ApiError } from '../http/api-error.js'
import { requireProjectActor } from '../http/authentication.js'
import { sendJson } from '../http/response.js'
import type { JobService } from '../jobs/service.js'

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
  if (!request.principal) throw new Error('Authenticated job route is missing a principal')
  return request.principal
}

export function createJobsRouter(auth: AuthService, jobs: JobService): Router {
  const router = Router()
  const collection = '/organizations/:organizationId/projects/:projectId/jobs'
  const read = requireProjectActor(auth, { resource: 'job', action: 'read' })
  router.get(collection, read, (request, response) => {
    const state = optionalQuery(request.query.state)
    const cursor = optionalQuery(request.query.cursor)
    if (state && !jobStates.includes(state as JobState))
      throw new ApiError(
        400,
        'Invalid job state',
        'invalid_job_state',
        'The job state is not supported.',
      )
    const result = jobs.list(
      principal(request),
      {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      },
      {
        limit: limitFrom(request.query.limit),
        ...(cursor ? { cursor } : {}),
        ...(state ? { state: state as JobState } : {}),
      },
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, 200, jobListSchema, result)
  })
  router.get(`${collection}/:jobId`, read, (request, response) => {
    const result = jobs.get(
      principal(request),
      {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      },
      parameter(request, 'jobId'),
    )
    response.set('cache-control', 'no-store')
    return sendJson(response, 200, jobSchema, result)
  })
  return router
}
