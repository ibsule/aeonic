import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  jobs,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobRunner } from '../src/jobs/runner.js'
import { ImageInspectionHandler } from '../src/media/image-inspection-handler.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'

const databases: DatabaseConnection[] = []
const runtimes: StorageRuntime[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(content: Buffer, mimeType = 'image/png') {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-image-handler-'))
  directories.push(directory)
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOCAL_STORAGE_PATH: join(directory, 'objects'),
  })
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const storage = createStorageRuntime(config)
  runtimes.push(storage)
  await storage.port.initialize()
  const now = new Date()
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const assetId = uuidv7()
  const assetVersionId = uuidv7()
  const storageObjectId = uuidv7()
  const jobId = uuidv7()
  const scope = { organizationId, projectId }
  const storageKey = createStorageObjectKey(scope, 'original', uuidv7())
  const sha256 = createHash('sha256').update(content).digest('hex')
  await storage.port.put(scope, storageKey, Readable.from(content), {
    maxBytes: content.byteLength,
    expectedBytes: content.byteLength,
    expectedSha256: sha256,
  })
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'image@example.com' }).run()
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
    .insert(storageObjects)
    .values({
      id: storageObjectId,
      organizationId,
      projectId,
      backend: 'local',
      namespace: 'original',
      objectKey: storageKey,
      state: 'available',
      sizeBytes: content.byteLength,
      sha256,
      finalizedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: uuidv7(),
      name: 'Image',
      mediaKind: 'image',
      state: 'processing',
      currentVersion: 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assetVersions)
    .values({
      id: assetVersionId,
      organizationId,
      projectId,
      assetId,
      version: 1,
      state: 'processing',
      storageObjectId,
      sha256,
      mimeType,
      sizeBytes: content.byteLength,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  database.db
    .insert(jobs)
    .values({
      id: jobId,
      organizationId,
      projectId,
      type: 'media.inspect.image',
      payload: { assetId, assetVersionId, storageObjectId },
      runAfter: now,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const repository = new SqliteJobRepository(database)
  const handler = new ImageInspectionHandler(database, storage, {
    maxInputPixels: 1_000_000,
    maxFrames: 10,
  })
  const runner = new JobRunner(repository, new Map([['media.inspect.image', handler.handle]]), {
    workerId: 'worker:image-test',
    leaseMs: 1_000,
    heartbeatMs: 100,
    timeoutMs: 2_000,
    pollMs: 10,
  })
  return { database, jobId, assetId, assetVersionId, scope, repository, runner }
}

describe('image inspection handler', () => {
  it('publishes normalized metadata and ready state atomically', async () => {
    const content = await sharp({
      create: { width: 40, height: 30, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer()
    const test = await fixture(content)

    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')
    assert.deepEqual(
      test.database.client
        .prepare('select state, width, height from asset_versions where id = ?')
        .get(test.assetVersionId),
      { state: 'ready', width: 40, height: 30 },
    )
    assert.equal(
      test.database.client
        .prepare('select state from assets where id = ?')
        .pluck()
        .get(test.assetId),
      'ready',
    )
    const metadata = test.database.client
      .prepare('select metadata from asset_versions where id = ?')
      .pluck()
      .get(test.assetVersionId) as string
    assert.equal(JSON.parse(metadata).inspection.processor.name, 'sharp')
    assert.equal(
      test.database.client
        .prepare("select count(*) from audit_events where action = 'asset.inspected'")
        .pluck()
        .get(),
      1,
    )
  })

  it('rejects corrupt bytes and records a stable terminal reason', async () => {
    const test = await fixture(Buffer.from('not an image'))

    assert.equal(await test.runner.runOnce(new AbortController().signal), 'failed')
    assert.equal(test.repository.findById(test.scope, test.jobId)?.errorCode, 'invalid_image')
    assert.equal(
      test.database.client
        .prepare('select state from assets where id = ?')
        .pluck()
        .get(test.assetId),
      'rejected',
    )
    assert.deepEqual(
      test.database.client
        .prepare(
          "select action, summary from audit_events where action = 'asset.inspection_failed'",
        )
        .get(),
      {
        action: 'asset.inspection_failed',
        summary: JSON.stringify({ assetVersionId: test.assetVersionId, reason: 'invalid_image' }),
      },
    )
  })
})
