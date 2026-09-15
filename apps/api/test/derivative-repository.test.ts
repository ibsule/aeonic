import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { parseImageTransformV1 } from '@aeonic/contracts'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import { createDerivativeCacheKey } from '../src/derivatives/cache-key.js'
import {
  DerivativeLeaseLostError,
  SqliteDerivativeRepository,
} from '../src/derivatives/repository.js'
import { imageProcessorFingerprint } from '../src/media/image-transformer.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'

const databases: DatabaseConnection[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function open(path: string): DatabaseConnection {
  const database = openDatabase(
    loadConfig({ NODE_ENV: 'test', DATABASE_PATH: path, DATABASE_BUSY_TIMEOUT_MS: '1000' }),
  )
  databases.push(database)
  return database
}

function seed(database: DatabaseConnection) {
  const now = new Date('2026-09-15T10:00:00.000Z')
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const assetId = uuidv7()
  const assetVersionId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'cache@example.com' }).run()
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
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: uuidv7(),
      name: 'Image',
      mediaKind: 'image',
      state: 'ready',
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
      state: 'ready',
      sha256: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  return { now, userId, organizationId, projectId, assetVersionId }
}

describe('derivative cache identity', () => {
  it('is stable for canonical inputs and changes across every output identity dimension', () => {
    const canonicalSpec = parseImageTransformV1('f_auto,w_0800').canonicalSpec
    const base = {
      sourceSha256: 'a'.repeat(64),
      canonicalSpec,
      outputFormat: 'webp' as const,
      processorFingerprint: imageProcessorFingerprint(),
    }
    const key = createDerivativeCacheKey(base)
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(createDerivativeCacheKey(base), key)
    assert.notEqual(createDerivativeCacheKey({ ...base, sourceSha256: 'b'.repeat(64) }), key)
    assert.notEqual(createDerivativeCacheKey({ ...base, outputFormat: 'avif' }), key)
    assert.notEqual(
      createDerivativeCacheKey({
        ...base,
        processorFingerprint: 'aeonic-image-v2;sharp=1;libvips=1',
      }),
      key,
    )
    assert.throws(
      () => createDerivativeCacheKey({ ...base, canonicalSpec: 'f_auto,w_800' }),
      /canonical/,
    )
  })
})

describe('derivative single-flight repository', () => {
  it('allows one owner, renews leases, and recovers expired generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeonic-derivatives-'))
    directories.push(directory)
    const path = join(directory, 'cache.db')
    const firstDatabase = open(path)
    firstDatabase.migrate()
    const seeded = seed(firstDatabase)
    const secondDatabase = open(path)
    const canonicalSpec = parseImageTransformV1('w_800,f_webp').canonicalSpec
    const input = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      assetVersionId: seeded.assetVersionId,
      cacheKey: createDerivativeCacheKey({
        sourceSha256: 'a'.repeat(64),
        canonicalSpec,
        outputFormat: 'webp',
        processorFingerprint: imageProcessorFingerprint(),
      }),
      canonicalSpec,
      outputFormat: 'webp' as const,
      processorFingerprint: imageProcessorFingerprint(),
      createdBy: seeded.userId,
    }
    const first = new SqliteDerivativeRepository(firstDatabase)
    const second = new SqliteDerivativeRepository(secondDatabase)
    const expiry = new Date(seeded.now.getTime() + 10_000)
    const extendedExpiry = new Date(seeded.now.getTime() + 20_000)

    const claimed = first.acquire(input, 'request:first', seeded.now, expiry)
    assert.equal(claimed.acquired, true)
    assert.equal(claimed.derivative.attempts, 1)
    const heartbeat = first.heartbeat(
      claimed.derivative.id,
      'request:first',
      new Date(seeded.now.getTime() + 5_000),
      extendedExpiry,
    )
    assert.equal(heartbeat.leaseExpiresAt?.getTime(), extendedExpiry.getTime())
    assert.equal(second.acquire(input, 'request:second', seeded.now, expiry).acquired, false)
    assert.equal(second.acquire(input, 'request:second', expiry, extendedExpiry).acquired, false)
    const reclaimed = second.acquire(
      input,
      'request:second',
      extendedExpiry,
      new Date(extendedExpiry.getTime() + 10_000),
    )
    assert.equal(reclaimed.acquired, true)
    assert.equal(reclaimed.derivative.attempts, 2)
    assert.throws(
      () => first.fail(claimed.derivative.id, 'request:first', extendedExpiry, 'stale'),
      DerivativeLeaseLostError,
    )
  })

  it('publishes complete metadata only through a live owned lease', () => {
    const database = open(':memory:')
    database.migrate()
    const seeded = seed(database)
    const repository = new SqliteDerivativeRepository(database)
    const canonicalSpec = parseImageTransformV1('w_400,f_avif').canonicalSpec
    const input = {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      assetVersionId: seeded.assetVersionId,
      cacheKey: createDerivativeCacheKey({
        sourceSha256: 'a'.repeat(64),
        canonicalSpec,
        outputFormat: 'avif',
        processorFingerprint: imageProcessorFingerprint(),
      }),
      canonicalSpec,
      outputFormat: 'avif' as const,
      processorFingerprint: imageProcessorFingerprint(),
    }
    const expiry = new Date(seeded.now.getTime() + 10_000)
    const claimed = repository.acquire(input, 'request:one', seeded.now, expiry).derivative
    const storageObjectId = uuidv7()
    database.db
      .insert(storageObjects)
      .values({
        id: storageObjectId,
        organizationId: seeded.organizationId,
        projectId: seeded.projectId,
        backend: 'local',
        namespace: 'derivative',
        objectKey: createStorageObjectKey(
          { organizationId: seeded.organizationId, projectId: seeded.projectId },
          'derivative',
          storageObjectId,
        ),
        state: 'available',
        sizeBytes: 42,
        sha256: 'b'.repeat(64),
        finalizedAt: seeded.now,
        createdAt: seeded.now,
        updatedAt: seeded.now,
      })
      .run()
    assert.throws(
      () =>
        repository.complete(claimed.id, 'request:one', seeded.now, {
          storageObjectId,
          sizeBytes: 42,
          sha256: 'b'.repeat(64),
          mimeType: 'image/webp',
          width: 400,
          height: 300,
        }),
      /MIME type conflicts/,
    )
    const ready = repository.complete(claimed.id, 'request:one', seeded.now, {
      storageObjectId,
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      mimeType: 'image/avif',
      width: 400,
      height: 300,
    })
    assert.equal(ready.state, 'ready')
    assert.equal(ready.leaseOwner, null)
    assert.equal(repository.acquire(input, 'request:two', seeded.now, expiry).acquired, false)
  })
})
