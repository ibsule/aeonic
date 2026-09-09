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
import { toNodeHandler } from 'better-auth/node'
import type { AuthService } from './auth/auth.js'
import { ApiKeyService } from './api-keys/service.js'
import { SqliteAuditRepository } from './audit/repository.js'
import { AuditService } from './audit/service.js'
import type { AppConfig } from './config.js'
import type { DatabaseConnection } from './db/database.js'
import { ApiError } from './http/api-error.js'
import { loadConfig } from './config.js'
import { sendProblem } from './http/problem.js'
import { createAppLogger, createHttpLogger } from './logging.js'
import { createHealthRouter } from './routes/health.js'
import { createApiKeysRouter } from './routes/api-keys.js'
import { createAuditEventsRouter } from './routes/audit-events.js'
import { createProjectsRouter } from './routes/projects.js'
import { createProjectMembersRouter } from './routes/project-members.js'
import { createSetupRouter } from './routes/setup.js'
import { ProjectService } from './projects/service.js'
import { ProjectMemberService } from './projects/members.js'
import { SetupService } from './setup/service.js'
import { createServiceState, type ServiceState } from './state.js'

export interface BuildAppOptions {
  config?: AppConfig
  state?: ServiceState
  logger?: Logger | false
  auth?: AuthService
  database?: DatabaseConnection
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
  if (error instanceof ApiError) return error.status
  if (!isHttpErrorLike(error)) return 500
  const candidate = error.statusCode ?? error.status
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

function errorCode(error: unknown, status: number): string {
  if (error instanceof ApiError) return error.code
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
  if (options.auth) {
    app.all('/api/auth/*splat', toNodeHandler(options.auth))
  }
  app.use(express.json({ limit: config.maxJsonBodyBytes, strict: true }))

  app.use('/health', createHealthRouter({ config, state }))
  if (options.database) {
    app.use('/api/v1/setup', createSetupRouter(new SetupService(options.database)))
    if (options.auth) {
      const projects = new ProjectService(options.database)
      app.use('/api/v1', createProjectsRouter(options.auth, projects))
      app.use(
        '/api/v1',
        createProjectMembersRouter(
          options.auth,
          new ProjectMemberService(options.database, projects),
        ),
      )
      app.use(
        '/api/v1',
        createApiKeysRouter(
          options.auth,
          new ApiKeyService(options.database, options.auth, projects),
        ),
      )
      app.use(
        '/api/v1',
        createAuditEventsRouter(
          options.auth,
          new AuditService(new SqliteAuditRepository(options.database), projects),
        ),
      )
    }
  }

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
      title: error instanceof ApiError ? error.title : errorTitle(status),
      code: errorCode(error, status),
      detail,
    })
  }
  app.use(errorHandler)

  return app
}
