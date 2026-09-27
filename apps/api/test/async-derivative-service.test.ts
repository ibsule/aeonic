import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  jobs,
  member,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import { AsyncDerivativeService, planAsyncDerivative } from '../src/derivatives/async-service.js'
import { ApiError } from '../src/http/api-error.js'
import { ProjectService } from '../src/projects/service.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime } from '../src/storage/factory.js'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(mediaKind: 'video' | 'document', mimeType: string) {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-async-derivative-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOCAL_STORAGE_PATH: join(directory, 'objects'),
  })
  const database = openDatabase(config)
  database.migrate()
  const storage = createStorageRuntime(config)
  await storage.port.initialize()
  cleanups.push(
    () => database.close(),
    () => storage.close(),
    () => rm(directory, { recursive: true }),
  )

  const now = new Date()
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const assetId = uuidv7()
  const assetVersionId = uuidv7()
  const storageObjectId = uuidv7()
  const publicId = uuidv7()
  const scope = { organizationId, projectId }
  database.db
    .insert(user)
    .values({ id: userId, name: 'Owner', email: `${mediaKind}@example.com` })
    .run()
  database.db
    .insert(organization)
    .values({ id: organizationId, name: 'Studio', slug: `${mediaKind}-studio`, createdAt: now })
    .run()
  database.db
    .insert(member)
    .values({ id: uuidv7(), organizationId, userId, role: 'owner', createdAt: now })
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
      ...scope,
      backend: 'local',
      namespace: 'original',
      objectKey: createStorageObjectKey(scope, 'original', storageObjectId),
      state: 'available',
      sizeBytes: 100,
      sha256: 'a'.repeat(64),
      finalizedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      ...scope,
      publicId,
      name: mediaKind,
      mediaKind,
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
      ...scope,
      assetId,
      version: 1,
      state: 'ready',
      storageObjectId,
      sha256: 'a'.repeat(64),
      mimeType,
      sizeBytes: 100,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  return {
    database,
    userId,
    publicId,
    scope,
    service: new AsyncDerivativeService(database, new ProjectService(database), storage),
  }
}

describe('asynchronous derivative service', () => {
  it('canonicalizes video work and queues it idempotently', async () => {
    const test = await fixture('video', 'video/mp4')
    const principal = { type: 'user' as const, userId: test.userId, sessionId: uuidv7() }
    const input = {
      operation: 'video_transcode' as const,
      preset: 'mp4-720p' as const,
      startSeconds: 1.25,
      durationSeconds: 3.5,
    }

    const first = test.service.create(principal, test.scope, test.publicId, 1, input, 'request-1')
    const second = test.service.create(principal, test.scope, test.publicId, 1, input, 'request-2')

    assert.equal(first.id, second.id)
    assert.equal(first.canonicalSpec, 'video.transcode.mp4-720p.start_1250.duration_3500')
    assert.equal(first.outputFormat, 'mp4')
    assert.equal(first.state, 'queued')
    assert.equal(test.database.db.select().from(jobs).all().length, 1)
  })

  it('rejects operations that do not match the source media', async () => {
    const test = await fixture('document', 'application/pdf')
    const principal = { type: 'user' as const, userId: test.userId, sessionId: uuidv7() }

    assert.throws(
      () =>
        test.service.create(
          principal,
          test.scope,
          test.publicId,
          1,
          { operation: 'video_poster' },
          'request-1',
        ),
      (error: unknown) => error instanceof ApiError && error.code === 'unsupported_derivative',
    )
  })

  it('keeps derivative status tenant-scoped', async () => {
    const test = await fixture('document', 'application/pdf')
    const principal = { type: 'user' as const, userId: test.userId, sessionId: uuidv7() }
    const derivative = test.service.create(
      principal,
      test.scope,
      test.publicId,
      1,
      { operation: 'pdf_text' },
      'request-1',
    )

    assert.throws(
      () => test.service.get(principal, { ...test.scope, projectId: uuidv7() }, derivative.id),
      ApiError,
    )
  })
})

describe('asynchronous derivative plans', () => {
  it('applies stable defaults', () => {
    assert.deepEqual(planAsyncDerivative({ operation: 'pdf_thumbnail' }), {
      kind: 'pdf_thumbnail',
      canonicalSpec: 'document.thumbnail.page_1.max_800',
      outputFormat: 'png',
      processorFingerprint: 'poppler-thumbnail-v1',
      parameters: { page: 1, maxDimension: 800 },
    })
  })
})
