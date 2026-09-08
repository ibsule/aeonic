import { createServer, type Server } from 'node:http'
import { buildApp } from './app.js'
import { type AppConfig, ConfigurationError, loadConfig } from './config.js'
import { createAppLogger } from './logging.js'
import { createServiceState } from './state.js'

function listen(server: Server, config: AppConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(config.port, config.host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections()
  })
}

async function start(): Promise<void> {
  let config: AppConfig
  try {
    config = loadConfig()
  } catch (error) {
    const message =
      error instanceof ConfigurationError ? error.message : 'Unknown configuration error'
    process.stderr.write(`${JSON.stringify({ level: 'fatal', message })}\n`)
    process.exitCode = 1
    return
  }

  const logger = createAppLogger(config)
  const state = createServiceState()
  const app = buildApp({ config, state, logger })
  const server = createServer(app)
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = Math.min(config.requestTimeoutMs + 1_000, 300_000)
  server.keepAliveTimeout = 72_000
  server.maxRequestsPerSocket = 1_000

  let stopping = false
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    state.markStopping()
    logger.info({ signal }, 'shutdown requested')

    const forceShutdown = setTimeout(() => {
      logger.fatal({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out')
      server.closeAllConnections()
      process.exit(1)
    }, config.shutdownTimeoutMs)
    forceShutdown.unref()

    try {
      await close(server)
      clearTimeout(forceShutdown)
      logger.info('shutdown complete')
    } catch (error) {
      clearTimeout(forceShutdown)
      logger.error({ err: error }, 'shutdown failed')
      process.exitCode = 1
    }
  }

  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))

  try {
    await listen(server, config)
    state.markReady()
    logger.info(
      { host: config.host, port: config.port, version: config.version },
      'Aeonic API ready',
    )
  } catch (error) {
    logger.fatal({ err: error }, 'API startup failed')
    process.exitCode = 1
    server.closeAllConnections()
  }
}

await start()
