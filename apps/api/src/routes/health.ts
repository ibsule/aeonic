import { serviceStatusSchema, type ServiceStatus } from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import type { AppConfig } from '../config.js'
import { sendProblem } from '../http/problem.js'
import { sendJson } from '../http/response.js'
import type { ServiceState } from '../state.js'

interface HealthRouteOptions {
  config: AppConfig
  state: ServiceState
}

export function createHealthRouter(options: HealthRouteOptions): Router {
  const router = Router()

  router.get('/live', (_request: Request, response: Response) => {
    const body: ServiceStatus = {
      status: 'ok',
      version: options.config.version,
      timestamp: new Date().toISOString(),
    }
    return sendJson(response, 200, serviceStatusSchema, body)
  })

  router.get('/ready', (request: Request, response: Response) => {
    if (!options.state.isReady()) {
      return sendProblem(request, response, {
        status: 503,
        title: 'Service unavailable',
        code: 'service_not_ready',
        detail: 'The service has not completed startup or is shutting down.',
      })
    }

    const body: ServiceStatus = {
      status: 'ready',
      version: options.config.version,
      timestamp: new Date().toISOString(),
    }
    return sendJson(response, 200, serviceStatusSchema, body)
  })

  return router
}
