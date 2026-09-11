import { projectStorageOverviewSchema } from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import type { AuthService } from '../auth/auth.js'
import { requireProjectActor } from '../http/authentication.js'
import { sendJson } from '../http/response.js'
import type { StorageService } from '../storage/service.js'

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function createStorageRouter(auth: AuthService, storage: StorageService): Router {
  const router = Router()
  router.get(
    '/organizations/:organizationId/projects/:projectId/storage',
    requireProjectActor(auth, { resource: 'asset', action: 'read' }),
    async (request: Request, response: Response) => {
      const principal = request.principal
      if (!principal) throw new Error('Authenticated storage route is missing a principal')
      const result = await storage.overview(principal, {
        organizationId: parameter(request, 'organizationId'),
        projectId: parameter(request, 'projectId'),
      })
      response.set('cache-control', 'no-store')
      sendJson(response, 200, projectStorageOverviewSchema, result)
    },
  )
  return router
}
