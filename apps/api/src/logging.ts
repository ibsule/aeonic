import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import pino, { type Logger } from 'pino'
import { type HttpLogger, pinoHttp, stdSerializers } from 'pino-http'
import type { AppConfig } from './config.js'

export function createAppLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'body.password',
        'body.token',
        'body.apiKey',
      ],
      censor: '[redacted]',
    },
  })
}

export function redactCapabilityUrl(value: string | undefined): string | undefined {
  if (value === undefined || !value.includes('signature=')) return value
  try {
    const parsed = new URL(value, 'http://aeonic.invalid')
    if (!parsed.searchParams.has('signature')) return value
    return `${parsed.pathname}?[signed-query-redacted]`
  } catch {
    return '[signed-url-redacted]'
  }
}

export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    serializers: {
      req: (request) => {
        const serialized = stdSerializers.req(request)
        return { ...serialized, url: redactCapabilityUrl(serialized.url) }
      },
    },
    genReqId: (_request: IncomingMessage, response: ServerResponse) => {
      const requestId = randomUUID()
      response.setHeader('x-request-id', requestId)
      return requestId
    },
  })
}
