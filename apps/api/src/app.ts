import { problemDetailsSchema, serviceStatusSchema } from '@aeonic/contracts'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify'
import type { AppConfig } from './config.js'
import { loadConfig } from './config.js'
import { sendProblem } from './http/problem.js'
import { registerHealthRoutes } from './routes/health.js'
import { createServiceState, type ServiceState } from './state.js'

export interface BuildAppOptions {
  config?: AppConfig
  state?: ServiceState
  logger?: FastifyServerOptions['logger']
}

function loggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'body.password',
        'body.token',
        'body.apiKey',
      ],
      censor: '[redacted]',
    },
  }
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig()
  const state = options.state ?? createServiceState(true)
  const logger = options.logger ?? loggerOptions(config)
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: config.maxJsonBodyBytes,
    requestTimeout: config.requestTimeoutMs,
    keepAliveTimeout: 72_000,
    connectionTimeout: 10_000,
  })

  app.addSchema(problemDetailsSchema)
  app.addSchema(serviceStatusSchema)

  void app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  })
  void app.register(cors, {
    origin: config.corsOrigins.length === 0 ? false : [...config.corsOrigins],
    credentials: config.corsOrigins.length > 0,
  })
  void app.register(registerHealthRoutes, { config, state })

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, {
      status: 404,
      title: 'Not Found',
      code: 'route_not_found',
      detail: 'The requested route does not exist.',
    }),
  )

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const isValidationError = error.validation !== undefined
    const status = isValidationError ? 400 : (error.statusCode ?? 500)

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
    } else {
      request.log.warn({ err: error }, 'request rejected')
    }

    return sendProblem(request, reply, {
      status,
      title: isValidationError
        ? 'Bad Request'
        : status >= 500
          ? 'Internal Server Error'
          : error.name,
      code: isValidationError
        ? 'request_validation_failed'
        : status >= 500
          ? 'internal_error'
          : 'request_failed',
      detail:
        status >= 500 && config.environment === 'production'
          ? 'An unexpected error occurred.'
          : error.message,
    })
  })

  return app
}
