import { hostname } from 'node:os'
import sharp from 'sharp'
import { ConfigurationError, loadConfig } from './config.js'
import { type DatabaseConnection, openDatabase } from './db/database.js'
import { SqliteJobRepository } from './jobs/repository.js'
import { JobRunner } from './jobs/runner.js'
import { createAppLogger } from './logging.js'
import { ImageInspectionHandler } from './media/image-inspection-handler.js'
import { createStorageRuntime, type StorageRuntime } from './storage/factory.js'

function derivedWorkerId(): string {
  const host =
    hostname()
      .replaceAll(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80) || 'localhost'
  return `worker:${host}:${process.pid}`
}

async function start(): Promise<void> {
  let config: ReturnType<typeof loadConfig>
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
  let database: DatabaseConnection | undefined
  let storage: StorageRuntime | undefined
  try {
    database = openDatabase(config)
    database.migrate()
    storage = createStorageRuntime(config)
    await storage.port.initialize()
  } catch (error) {
    logger.fatal({ err: error }, 'worker dependency startup failed')
    storage?.close()
    database?.close()
    process.exitCode = 1
    return
  }

  sharp.cache({ files: 0, items: 100, memory: 64 })
  sharp.concurrency(1)
  const imageInspection = new ImageInspectionHandler(database, storage, {
    maxInputPixels: config.imageMaxInputPixels,
    maxFrames: config.imageMaxFrames,
  })
  const workerId = config.workerId ?? derivedWorkerId()
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([['media.inspect.image', imageInspection.handle]]),
    {
      workerId,
      leaseMs: config.workerLeaseMs,
      heartbeatMs: config.workerHeartbeatMs,
      timeoutMs: config.workerJobTimeoutMs,
      pollMs: config.workerPollMs,
    },
  )
  const shutdown = new AbortController()
  let stopping = false
  let forcedShutdown: NodeJS.Timeout | undefined
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'worker shutdown requested')
    forcedShutdown = setTimeout(() => {
      logger.fatal(
        { timeoutMs: config.shutdownTimeoutMs },
        'worker exceeded its graceful shutdown deadline',
      )
      process.exit(1)
    }, config.shutdownTimeoutMs)
    forcedShutdown.unref()
    shutdown.abort(new Error(`Worker received ${signal}.`))
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  logger.info(
    {
      workerId,
      handlers: ['media.inspect.image'],
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
    },
    'Aeonic media worker ready',
  )
  try {
    await runner.run(shutdown.signal)
    logger.info('worker shutdown complete')
  } catch (error) {
    logger.fatal({ err: error }, 'worker stopped unexpectedly')
    process.exitCode = 1
  } finally {
    if (forcedShutdown) clearTimeout(forcedShutdown)
    storage.close()
    database.close()
  }
}

await start()
