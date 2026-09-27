import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { parseImageTransformV1 } from '@aeonic/contracts'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  derivatives,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import type { OriginalAsset } from '../src/delivery/service.js'
import { ImageDerivativeService } from '../src/derivatives/service.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import type { StorageRuntime } from '../src/storage/factory.js'
import { LocalStorage } from '../src/storage/local-storage.js'

const databases: DatabaseConnection[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-image-derivative-'))
  directories.push(directory)
  const database = openDatabase(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }))
  databases.push(database)
  database.migrate()
  const port = new LocalStorage({ rootDirectory: directory })
  await port.initialize()
  const storage: StorageRuntime = { backend: 'local', port, close: () => undefined }
  const now = new Date('2026-09-27T12:00:00.000Z')
  const scope = { organizationId: uuidv7(), projectId: uuidv7() }
  const userId = uuidv7()
  const assetId = uuidv7()
  const versionId = uuidv7()
  const storageObjectId = uuidv7()
  const storageKey = createStorageObjectKey(scope, 'original', storageObjectId)
  const content = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#7c3aed' },
  })
    .png()
    .toBuffer()
  const stored = await port.put(scope, storageKey, Readable.from(content), {
    maxBytes: 1_000_000,
    expectedBytes: content.byteLength,
  })
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'owner@example.com' }).run()
  database.db
    .insert(organization)
    .values({ id: scope.organizationId, name: 'Studio', slug: 'studio', createdAt: now })
    .run()
  database.db
    .insert(projects)
    .values({
      id: scope.projectId,
      organizationId: scope.organizationId,
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
      objectKey: storageKey,
      state: 'available',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
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
      publicId: uuidv7(),
      name: 'Source',
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
      id: versionId,
      ...scope,
      assetId,
      storageObjectId,
      version: 1,
      state: 'ready',
      sha256: stored.sha256,
      mimeType: 'image/png',
      sizeBytes: stored.sizeBytes,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  const source: OriginalAsset = {
    scope,
    assetId,
    versionId,
    publicId: uuidv7(),
    version: 1,
    visibility: 'private',
    mediaKind: 'image',
    filename: 'source.png',
    mimeType: 'image/png',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    finalizedAt: now,
    storageKey,
    storageBackend: 'local',
  }
  return { database, storage, source }
}

const limits = {
  imageMaxInputPixels: 1_000_000,
  imageMaxFrames: 1,
  imageMaxOutputBytes: 1_000_000,
  imageTransformTimeoutMs: 5_000,
}

describe('image derivative generation', () => {
  it('streams, validates, publishes, and reuses an immutable derivative', async () => {
    const { database, storage, source } = await fixture()
    const service = new ImageDerivativeService(database, storage, limits)
    const transform = parseImageTransformV1('w_40,f_webp,q_75')

    const generated = await service.resolve(source, transform, 'webp', 'request:first')
    assert.equal(generated.mimeType, 'image/webp')
    assert.equal(generated.width, 40)
    assert.equal(generated.height, 27)
    assert.equal(generated.storageKey.startsWith('derivative/'), true)
    const cached = await service.resolve(source, transform, 'webp', 'request:second')
    assert.equal(cached.id, generated.id)
    assert.equal(database.db.select().from(derivatives).all().length, 1)

    const stream = await service.open(generated, undefined, new AbortController().signal)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
    const metadata = await sharp(Buffer.concat(chunks)).metadata()
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.width, 40)
  })

  it('cleans failed output and allows a later request to retry the same identity', async () => {
    const { database, storage, source } = await fixture()
    const transform = parseImageTransformV1('w_80,f_png')
    const constrained = new ImageDerivativeService(database, storage, {
      ...limits,
      imageMaxOutputBytes: 1,
    })
    await assert.rejects(
      constrained.resolve(source, transform, 'png', 'request:first'),
      /maximum|exceed|size/i,
    )
    const failed = database.db.select().from(derivatives).get()
    assert.equal(failed?.state, 'failed')
    assert.equal(failed?.attempts, 1)

    const recovered = await new ImageDerivativeService(database, storage, limits).resolve(
      source,
      transform,
      'png',
      'request:second',
    )
    assert.equal(recovered.outputFormat, 'png')
    const ready = database.db.select().from(derivatives).get()
    assert.equal(ready?.state, 'ready')
    assert.equal(ready?.attempts, 2)
  })
})
