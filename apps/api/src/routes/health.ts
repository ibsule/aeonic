import { problemDetailsSchema, serviceStatusSchema, type ServiceStatus } from '@aeonic/contracts'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { sendProblem } from '../http/problem.js'
import type { ServiceState } from '../state.js'

interface HealthRouteOptions {
  config: AppConfig
  state: ServiceState
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['system'],
        response: { 200: serviceStatusSchema },
      },
    },
    async (): Promise<ServiceStatus> => ({
      status: 'ok',
      version: options.config.version,
      timestamp: new Date().toISOString(),
    }),
  )

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['system'],
        response: {
          200: serviceStatusSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.state.isReady()) {
        return sendProblem(request, reply, {
          status: 503,
          title: 'Service unavailable',
          code: 'service_not_ready',
          detail: 'The service has not completed startup or is shutting down.',
        })
      }

      const response: ServiceStatus = {
        status: 'ready',
        version: options.config.version,
        timestamp: new Date().toISOString(),
      }
      return reply.send(response)
    },
  )
}
