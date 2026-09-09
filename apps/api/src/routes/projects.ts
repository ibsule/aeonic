import {
  createProjectRequestSchema,
  type CreateProjectRequest,
  projectListSchema,
  projectSchema,
  updateProjectRequestSchema,
  type UpdateProjectRequest,
} from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { getUserPrincipal, requireUser } from '../http/authentication.js'
import { ApiError } from '../http/api-error.js'
import { matchesSchema, sendJson } from '../http/response.js'
import { projectEtag, type ProjectService } from '../projects/service.js'

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

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function createProjectsRouter(auth: AuthService, projects: ProjectService): Router {
  const router = Router()
  router.use(requireUser(auth))

  router.get('/organizations/:organizationId/projects', (request: Request, response: Response) => {
    const principal = getUserPrincipal(request)
    const result = projects.list(principal.userId, parameter(request, 'organizationId'))
    return sendJson(response, 200, projectListSchema, result)
  })

  router.post('/organizations/:organizationId/projects', (request: Request, response: Response) => {
    const principal = getUserPrincipal(request)
    const input = requireBody<CreateProjectRequest>(createProjectRequestSchema, request.body)
    const project = projects.create(
      principal.userId,
      parameter(request, 'organizationId'),
      input,
      String(request.id),
    )
    response.location(`/api/v1/organizations/${project.organizationId}/projects/${project.id}`)
    response.set('etag', projectEtag(project))
    return sendJson(response, 201, projectSchema, project)
  })

  router.get(
    '/organizations/:organizationId/projects/:projectId',
    (request: Request, response: Response) => {
      const principal = getUserPrincipal(request)
      const project = projects.get(
        principal.userId,
        parameter(request, 'organizationId'),
        parameter(request, 'projectId'),
      )
      response.set('etag', projectEtag(project))
      return sendJson(response, 200, projectSchema, project)
    },
  )

  router.patch('/organizations/:organizationId/projects/:projectId', (request, response) => {
    const principal = getUserPrincipal(request)
    const input = requireBody<UpdateProjectRequest>(updateProjectRequestSchema, request.body)
    const project = projects.update(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      request.get('if-match'),
      input,
      String(request.id),
    )
    response.set('etag', projectEtag(project))
    return sendJson(response, 200, projectSchema, project)
  })

  router.delete('/organizations/:organizationId/projects/:projectId', (request, response) => {
    const principal = getUserPrincipal(request)
    projects.delete(
      principal.userId,
      parameter(request, 'organizationId'),
      parameter(request, 'projectId'),
      request.get('if-match'),
      String(request.id),
    )
    return response.status(204).send()
  })

  return router
}
