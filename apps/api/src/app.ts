import cors from 'cors'
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import helmet from 'helmet'
import pino, { type Logger } from 'pino'
import type { AppConfig } from './config.js'
import { loadConfig } from './config.js'
import { sendProblem } from './http/problem.js'
import { createAppLogger, createHttpLogger } from './logging.js'
import { createHealthRouter } from './routes/health.js'
import { createServiceState, type ServiceState } from './state.js'

export interface BuildAppOptions {
  config?: AppConfig
  state?: ServiceState
  logger?: Logger | false
}

interface HttpErrorLike {
  status?: unknown
  statusCode?: unknown
  type?: unknown
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return typeof error === 'object' && error !== null
}

function errorStatus(error: unknown): number {
  if (!isHttpErrorLike(error)) return 500
  const candidate = error.statusCode ?? error.status
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function errorCode(error: unknown, status: number): string {
  if (isHttpErrorLike(error) && error.type === 'entity.too.large') return 'request_too_large'
  if (status === 400 && error instanceof SyntaxError) return 'invalid_json'
  return status >= 500 ? 'internal_error' : 'request_failed'
}

function errorTitle(status: number): string {
  if (status === 400) return 'Bad Request'
  if (status === 413) return 'Payload Too Large'
  return status >= 500 ? 'Internal Server Error' : 'Request Failed'
}

export function buildApp(options: BuildAppOptions = {}): Express {
  const config = options.config ?? loadConfig()
  const state = options.state ?? createServiceState(true)
  const logger =
    options.logger === false
      ? pino({ level: 'silent' })
      : (options.logger ?? createAppLogger(config))
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy)
  app.use(createHttpLogger(logger))
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  )
  app.use(
    cors({
      origin: config.corsOrigins.length === 0 ? false : [...config.corsOrigins],
      credentials: config.corsOrigins.length > 0,
    }),
  )
  app.use(express.json({ limit: config.maxJsonBodyBytes, strict: true }))

  app.use('/health', createHealthRouter({ config, state }))

  app.use((request: Request, response: Response) =>
    sendProblem(request, response, {
      status: 404,
      title: 'Not Found',
      code: 'route_not_found',
      detail: 'The requested route does not exist.',
    }),
  )

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    const status = errorStatus(error)
    const detail =
      status >= 500 && config.environment === 'production'
        ? 'An unexpected error occurred.'
        : errorMessage(error)

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
    } else {
      request.log.warn({ err: error }, 'request rejected')
    }

    sendProblem(request, response, {
      status,
      title: errorTitle(status),
      code: errorCode(error, status),
      detail,
    })
  }
  app.use(errorHandler)

  return app
}
