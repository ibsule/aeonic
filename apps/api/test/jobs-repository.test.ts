import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { jobs, organization, projects, user } from '../src/db/schema.js'
import { JobLeaseLostError, retryDelayMs, SqliteJobRepository } from '../src/jobs/repository.js'

const databases: DatabaseConnection[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function createDatabase(path = ':memory:'): DatabaseConnection {
  const database = openDatabase(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: path,
      DATABASE_BUSY_TIMEOUT_MS: '1000',
    }),
  )
  databases.push(database)
  return database
}

function seedProject(database: DatabaseConnection) {
  const now = new Date('2026-09-12T10:00:00.000Z')
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'jobs@example.com' }).run()
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
  return { now, userId, scope: { organizationId, projectId } }
}

function enqueue(
  database: DatabaseConnection,
  seeded: ReturnType<typeof seedProject>,
  overrides: Partial<typeof jobs.$inferInsert> = {},
): string {
  const id = overrides.id ?? uuidv7()
  database.db
    .insert(jobs)
    .values({
      id,
      organizationId: seeded.scope.organizationId,
      projectId: seeded.scope.projectId,
      type: 'media.inspect',
      payload: { assetId: uuidv7() },
      runAfter: seeded.now,
      createdBy: seeded.userId,
      createdAt: seeded.now,
      updatedAt: seeded.now,
      ...overrides,
    })
    .run()
  return id
}

describe('durable job repository', () => {
  it('atomically leases one due job across database connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeonic-jobs-'))
    directories.push(directory)
    const path = join(directory, 'jobs.db')
    const firstDatabase = createDatabase(path)
    firstDatabase.migrate()
    const seeded = seedProject(firstDatabase)
    const jobId = enqueue(firstDatabase, seeded)
    const secondDatabase = createDatabase(path)
    const leaseUntil = new Date(seeded.now.getTime() + 30_000)

    const first = new SqliteJobRepository(firstDatabase).claimNext(
      'worker:first',
      ['media.inspect'],
      seeded.now,
      leaseUntil,
    )
    const second = new SqliteJobRepository(secondDatabase).claimNext(
      'worker:second',
      ['media.inspect'],
      seeded.now,
      leaseUntil,
    )

    assert.equal(first?.id, jobId)
    assert.equal(first?.state, 'running')
    assert.equal(first?.attempts, 1)
    assert.equal(first?.leaseOwner, 'worker:first')
    assert.equal(second, null)
  })

  it('ignores future work and reclaims an expired lease without duplicating the job', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const futureId = enqueue(database, seeded, {
      runAfter: new Date(seeded.now.getTime() + 60_000),
    })
    const dueId = enqueue(database, seeded)
    const firstLease = new Date(seeded.now.getTime() + 10_000)

    assert.equal(
      repository.claimNext('worker:one', ['media.inspect'], seeded.now, firstLease)?.id,
      dueId,
    )
    assert.equal(
      repository.claimNext('worker:two', ['media.inspect'], seeded.now, firstLease),
      null,
    )
    const reclaimed = repository.claimNext(
      'worker:two',
      ['media.inspect'],
      firstLease,
      new Date(firstLease.getTime() + 10_000),
    )

    assert.equal(reclaimed?.id, dueId)
    assert.equal(reclaimed?.attempts, 2)
    assert.equal(reclaimed?.leaseOwner, 'worker:two')
    assert.equal(repository.findById(seeded.scope, futureId)?.state, 'queued')
  })

  it('requires a live owned lease for heartbeats, progress, and completion', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const jobId = enqueue(database, seeded)
    const initialExpiry = new Date(seeded.now.getTime() + 10_000)
    repository.claimNext('worker:one', ['media.inspect'], seeded.now, initialExpiry)
    const heartbeatAt = new Date(seeded.now.getTime() + 5_000)
    const extendedExpiry = new Date(seeded.now.getTime() + 20_000)

    assert.equal(
      repository
        .heartbeat(jobId, 'worker:one', heartbeatAt, extendedExpiry)
        .leaseExpiresAt?.getTime(),
      extendedExpiry.getTime(),
    )
    assert.equal(repository.updateProgress(jobId, 'worker:one', heartbeatAt, 40).progress, 40)
    assert.throws(() => repository.succeed(jobId, 'worker:other', heartbeatAt), JobLeaseLostError)
    const completed = repository.succeed(jobId, 'worker:one', heartbeatAt)

    assert.equal(completed.state, 'succeeded')
    assert.equal(completed.progress, 100)
    assert.equal(completed.leaseOwner, null)
    assert.equal(completed.completedAt?.getTime(), heartbeatAt.getTime())
    assert.throws(
      () => repository.heartbeat(jobId, 'worker:one', heartbeatAt, extendedExpiry),
      JobLeaseLostError,
    )
  })

  it('retries with bounded exponential backoff and fails the final attempt', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const jobId = enqueue(database, seeded, { maxAttempts: 2 })
    const firstExpiry = new Date(seeded.now.getTime() + 10_000)
    repository.claimNext('worker:one', ['media.inspect'], seeded.now, firstExpiry)

    const retry = repository.fail(jobId, 'worker:one', seeded.now, {
      code: 'processor_timeout',
      message: 'The processor exceeded its wall-time limit.',
    })
    assert.equal(retry.state, 'queued')
    assert.equal(retry.runAfter.getTime(), seeded.now.getTime() + retryDelayMs(1))
    assert.equal(retry.completedAt, null)

    const retryTime = retry.runAfter
    repository.claimNext(
      'worker:two',
      ['media.inspect'],
      retryTime,
      new Date(retryTime.getTime() + 10_000),
    )
    const failed = repository.fail(jobId, 'worker:two', retryTime, {
      code: 'invalid_media',
      message: 'The decoder rejected the media.',
    })

    assert.equal(failed.state, 'failed')
    assert.equal(failed.attempts, 2)
    assert.equal(failed.errorCode, 'invalid_media')
    assert.equal(failed.completedAt?.getTime(), retryTime.getTime())
  })

  it('marks a crashed final attempt failed when its lease expires', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const jobId = enqueue(database, seeded, { maxAttempts: 1 })
    const expiry = new Date(seeded.now.getTime() + 10_000)
    repository.claimNext('worker:one', ['media.inspect'], seeded.now, expiry)

    assert.equal(
      repository.claimNext(
        'worker:two',
        ['media.inspect'],
        expiry,
        new Date(expiry.getTime() + 10_000),
      ),
      null,
    )
    const failed = repository.findById(seeded.scope, jobId)
    assert.equal(failed?.state, 'failed')
    assert.equal(failed?.errorCode, 'attempts_exhausted')
    assert.equal(failed?.completedAt?.getTime(), expiry.getTime())
  })

  it('does not return jobs through a different tenant scope', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const jobId = enqueue(database, seeded)

    assert.equal(repository.findById(seeded.scope, jobId)?.id, jobId)
    assert.equal(repository.findById({ ...seeded.scope, projectId: uuidv7() }, jobId), null)
  })

  it('claims only job types registered by the worker', () => {
    const database = createDatabase()
    database.migrate()
    const seeded = seedProject(database)
    const repository = new SqliteJobRepository(database)
    const jobId = enqueue(database, seeded)
    const leaseUntil = new Date(seeded.now.getTime() + 10_000)

    assert.equal(repository.claimNext('worker:one', [], seeded.now, leaseUntil), null)
    assert.equal(
      repository.claimNext('worker:one', ['media.transform'], seeded.now, leaseUntil),
      null,
    )
    assert.equal(
      repository.claimNext('worker:one', ['media.inspect'], seeded.now, leaseUntil)?.id,
      jobId,
    )
  })
})
