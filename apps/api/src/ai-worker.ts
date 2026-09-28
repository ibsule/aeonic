import { hostname } from 'node:os'
import sharp from 'sharp'
import { createAiDependencies } from './ai/factory.js'
import { AiIndexingHandler } from './ai/indexing-handler.js'
import { ConfigurationError, loadConfig } from './config.js'
import { type DatabaseConnection, openDatabase } from './db/database.js'
import { SqliteJobRepository } from './jobs/repository.js'
import { JobRunner } from './jobs/runner.js'
import { createAppLogger } from './logging.js'
import { createStorageRuntime, type StorageRuntime } from './storage/factory.js'

function workerId(configured?: string): string {
  if (configured) return configured
  const host =
    hostname()
      .replaceAll(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80) || 'localhost'
  return `ai-worker:${host}:${process.pid}`
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
  if (!config.aiEnabled) {
    logger.fatal('the AI worker requires AI_ENABLED=true')
    process.exitCode = 1
    return
  }

  let database: DatabaseConnection | undefined
  let storage: StorageRuntime | undefined
  try {
    database = openDatabase(config)
    database.migrate()
    storage = createStorageRuntime(config)
    await storage.port.initialize()
  } catch (error) {
    logger.fatal({ err: error }, 'AI worker dependency startup failed')
    storage?.close()
    database?.close()
    process.exitCode = 1
    return
  }
  const dependencies = createAiDependencies(config)
  if (!dependencies.vision || !dependencies.embeddings || !dependencies.vectors) {
    logger.fatal('the configured AI provider or vector index is unavailable')
    storage.close()
    database.close()
    process.exitCode = 1
    return
  }

  sharp.cache({ files: 0, items: 50, memory: 96 })
  sharp.concurrency(1)
  const handler = new AiIndexingHandler(
    database,
    storage,
    config,
    dependencies.vision,
    dependencies.embeddings,
    dependencies.vectors,
  )
  const id = workerId(config.workerId)
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([
      ['ai.reindex', handler.reindex],
      ['ai.delete_asset', handler.deleteAsset],
      ['ai.delete_index', handler.deleteIndex],
    ]),
    {
      workerId: id,
      leaseMs: config.workerLeaseMs,
      heartbeatMs: config.workerHeartbeatMs,
      timeoutMs: config.workerJobTimeoutMs,
      pollMs: config.workerPollMs,
    },
  )
  const shutdown = new AbortController()
  let stopping = false
  let deadline: NodeJS.Timeout | undefined
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'AI worker shutdown requested')
    deadline = setTimeout(() => process.exit(1), config.shutdownTimeoutMs)
    deadline.unref()
    shutdown.abort(new Error(`AI worker received ${signal}.`))
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
  logger.info(
    {
      workerId: id,
      provider: dependencies.vision.provider,
      visionModel: dependencies.vision.model,
      embeddingModel: dependencies.embeddings.model,
      dimensions: dependencies.embeddings.dimensions,
    },
    'Aeonic AI worker ready',
  )
  try {
    await runner.run(shutdown.signal)
  } catch (error) {
    logger.fatal({ err: error }, 'AI worker stopped unexpectedly')
    process.exitCode = 1
  } finally {
    if (deadline) clearTimeout(deadline)
    storage.close()
    database.close()
  }
}

await start()
