import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { jobs, organization, projects, user } from '../src/db/schema.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobExecutionError, type JobHandler, JobRunner } from '../src/jobs/runner.js'

const databases: DatabaseConnection[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture(type = 'media.inspect', maxAttempts = 3) {
  const database = openDatabase(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }))
  databases.push(database)
  database.migrate()
  const now = new Date()
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const jobId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'runner@example.com' }).run()
  database.db
    .insert(organization)
    .values({ id: organizationId, name: 'Studio', slug: 'studio', createdAt: now })
    .run()
  database.db
    .insert(projects)
    .values({
      id: projectId,
      organizationId,
      name: 'Library',
      slug: 'library',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(jobs)
    .values({
      id: jobId,
      organizationId,
      projectId,
      type,
      payload: { assetId: uuidv7() },
      maxAttempts,
      runAfter: now,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const repository = new SqliteJobRepository(database)
  const createRunner = (handlers: ReadonlyMap<string, JobHandler>, timeoutMs = 1_000) =>
    new JobRunner(repository, handlers, {
      workerId: 'worker:test',
      leaseMs: 200,
      heartbeatMs: 25,
      timeoutMs,
      pollMs: 5,
    })
  return {
    database,
    jobId,
    repository,
    scope: { organizationId, projectId },
    createRunner,
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('job runner', () => {
  it('reports progress and completes a handled job', async () => {
    const test = fixture()
    const runner = test.createRunner(
      new Map([
        [
          'media.inspect',
          async (_job, context) => {
            context.reportProgress(45)
          },
        ],
      ]),
    )

    assert.equal(await runner.runOnce(new AbortController().signal), 'succeeded')
    const completed = test.repository.findById(test.scope, test.jobId)
    assert.equal(completed?.state, 'succeeded')
    assert.equal(completed?.progress, 100)
    assert.equal(completed?.attempts, 1)
  })

  it('requeues retryable failures without persisting internal exception details', async () => {
    const test = fixture()
    const runner = test.createRunner(
      new Map([
        [
          'media.inspect',
          async () => {
            throw new Error('sensitive decoder command output')
          },
        ],
      ]),
    )

    assert.equal(await runner.runOnce(new AbortController().signal), 'retrying')
    const retry = test.repository.findById(test.scope, test.jobId)
    assert.equal(retry?.state, 'queued')
    assert.equal(retry?.errorCode, 'processing_failed')
    assert.equal(retry?.errorMessage, 'The job handler failed unexpectedly.')
  })

  it('fails unsupported and explicitly terminal work without retrying', async () => {
    const unsupported = fixture('unknown.job')
    assert.equal(
      await unsupported.createRunner(new Map()).runOnce(new AbortController().signal),
      'failed',
    )
    assert.equal(unsupported.repository.findById(unsupported.scope, unsupported.jobId)?.attempts, 1)

    const rejected = fixture()
    const runner = rejected.createRunner(
      new Map([
        [
          'media.inspect',
          async () => {
            throw new JobExecutionError('unsupported_media', 'The media is unsupported.', false)
          },
        ],
      ]),
    )
    assert.equal(await runner.runOnce(new AbortController().signal), 'failed')
    assert.equal(rejected.repository.findById(rejected.scope, rejected.jobId)?.attempts, 1)
  })

  it('aborts timed-out work and schedules a safe retry', async () => {
    const test = fixture()
    const runner = test.createRunner(
      new Map([
        [
          'media.inspect',
          async (_job, context) => {
            await waitForAbort(context.signal)
            throw context.signal.reason
          },
        ],
      ]),
      40,
    )

    assert.equal(await runner.runOnce(new AbortController().signal), 'retrying')
    const retry = test.repository.findById(test.scope, test.jobId)
    assert.equal(retry?.errorCode, 'processing_timeout')
    assert.equal(retry?.state, 'queued')
  })

  it('leaves interrupted work leased for crash-safe recovery', async () => {
    const test = fixture()
    const shutdown = new AbortController()
    const runner = test.createRunner(
      new Map([
        [
          'media.inspect',
          async (_job, context) => {
            await waitForAbort(context.signal)
            throw context.signal.reason
          },
        ],
      ]),
    )
    setTimeout(() => shutdown.abort(new Error('shutdown')), 20)

    assert.equal(await runner.runOnce(shutdown.signal), 'interrupted')
    const interrupted = test.repository.findById(test.scope, test.jobId)
    assert.equal(interrupted?.state, 'running')
    assert.equal(interrupted?.leaseOwner, 'worker:test')
  })

  it('polls while idle and exits promptly when shutdown is requested', async () => {
    const test = fixture()
    test.database.db.delete(jobs).run()
    const shutdown = new AbortController()
    const running = test.createRunner(new Map()).run(shutdown.signal)
    setTimeout(() => shutdown.abort(), 20)

    await running
    assert.equal(shutdown.signal.aborted, true)
  })
})
