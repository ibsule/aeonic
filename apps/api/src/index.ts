import { buildApp } from './app.js'
import { type AppConfig, ConfigurationError, loadConfig } from './config.js'
import { createServiceState } from './state.js'

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

  const state = createServiceState()
  const app = buildApp({ config, state })
  let stopping = false

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    state.markStopping()
    app.log.info({ signal }, 'shutdown requested')

    const forceShutdown = setTimeout(() => {
      app.log.fatal({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out')
      process.exit(1)
    }, config.shutdownTimeoutMs)
    forceShutdown.unref()

    try {
      await app.close()
      clearTimeout(forceShutdown)
      app.log.info('shutdown complete')
    } catch (error) {
      clearTimeout(forceShutdown)
      app.log.error({ err: error }, 'shutdown failed')
      process.exitCode = 1
    }
  }

  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('SIGTERM', () => void stop('SIGTERM'))

  try {
    await app.listen({ host: config.host, port: config.port })
    state.markReady()
    app.log.info({ version: config.version }, 'Aeonic API ready')
  } catch (error) {
    app.log.fatal({ err: error }, 'API startup failed')
    process.exitCode = 1
    await app.close()
  }
}

await start()
