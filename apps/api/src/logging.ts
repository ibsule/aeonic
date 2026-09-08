import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import pino, { type Logger } from 'pino'
import { type HttpLogger, pinoHttp } from 'pino-http'
import type { AppConfig } from './config.js'

export function createAppLogger(config: AppConfig): Logger {
  return pino({
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
  })
}

export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId: (_request: IncomingMessage, response: ServerResponse) => {
      const requestId = randomUUID()
      response.setHeader('x-request-id', requestId)
      return requestId
    },
  })
}
