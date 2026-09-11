import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { type AppConfig, loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { ProjectService } from '../src/projects/service.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'
import { TusUploadService } from '../src/uploads/tus-service.js'
import { TusStagingStore } from '../src/uploads/tus-staging.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const databases: DatabaseConnection[] = []
const storageRuntimes: StorageRuntime[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const storage of storageRuntimes.splice(0)) storage.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function uploadMetadata(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',')
}

function createTestApp(overrides: Partial<AppConfig> = {}) {
  const directory = join(tmpdir(), `aeonic-tus-api-${uuidv7()}`)
  const objectDirectory = join(directory, 'objects')
  const tusDirectory = join(directory, 'tus')
  directories.push(directory)
  const config: AppConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
    }),
    localStoragePath: objectDirectory,
    tusStoragePath: tusDirectory,
    ...overrides,
  }
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const auth = createAuth(config, database)
  const storage = createStorageRuntime(config)
  storageRuntimes.push(storage)
  const staging = new TusStagingStore(tusDirectory)
  const tusUploads = new TusUploadService(
    database,
    new ProjectService(database),
    storage,
    staging,
    config,
  )
  const app = buildApp({ config, auth, database, storage, tusUploads, logger: false })
  return { app, database, staging, tusUploads }
}

async function initializeOwner(app: ReturnType<typeof buildApp>) {
  const setup = await request(app).post('/api/v1/setup').send({
    name: 'Project Owner',
    email: 'owner@example.com',
    password: 'a-strong-development-password',
    organizationName: 'Example Studio',
    organizationSlug: 'example-studio',
    projectName: 'Media Library',
    projectSlug: 'media-library',
  })
  const agent = request.agent(app)
  await agent.post('/api/auth/sign-in/email').send({
    email: 'owner@example.com',
    password: 'a-strong-development-password',
  })
  const collection = `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}/uploads`
  return { agent, collection }
}

async function createUpload(
  agent: ReturnType<typeof request.agent>,
  collection: string,
  metadata = uploadMetadata({ filename: 'pixel.png', filetype: 'image/png' }),
) {
  return agent
    .post(collection)
    .set('tus-resumable', '1.0.0')
    .set('upload-length', String(png.byteLength))
    .set('upload-metadata', metadata)
    .send()
}

describe('tus resumable uploads', () => {
  it('advertises only implemented extensions through authenticated browser CORS', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)

    const discovered = await request(app)
      .options(owner.collection)
      .set('origin', 'http://localhost:3000')
      .set('access-control-request-method', 'PATCH')

    assert.equal(discovered.status, 204)
    assert.equal(discovered.headers['tus-version'], '1.0.0')
    assert.equal(discovered.headers['tus-extension'], 'creation,expiration,checksum,termination')
    assert.equal(discovered.headers['tus-checksum-algorithm'], 'sha1,sha256')
    assert.equal(discovered.headers['tus-max-size'], String(5 * 1024 * 1024 * 1024))
    assert.match(discovered.headers['access-control-expose-headers'] ?? '', /Upload-Offset/i)
  })

  it('creates, resumes, verifies chunks, and finalizes through the shared upload lifecycle', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const metadata = uploadMetadata({
      filename: 'pixel.png',
      filetype: 'image/png',
      name: 'Pixel',
      folder: 'campaign/hero',
      visibility: 'public',
    })
    const created = await createUpload(owner.agent, owner.collection, metadata)

    assert.equal(created.status, 201)
    assert.equal(created.headers['tus-resumable'], '1.0.0')
    assert.equal(created.headers['upload-offset'], '0')
    assert.match(created.headers.location ?? '', /\/uploads\/[0-9a-f-]+$/)
    assert.match(created.headers['upload-expires'] ?? '', /GMT$/)
    assert.match(created.headers['upload-asset-id'] ?? '', /^[0-9a-f-]+$/)
    const location = created.headers.location as string

    const firstChunk = png.subarray(0, 24)
    const firstChecksum = createHash('sha1').update(firstChunk).digest('base64')
    const first = await owner.agent
      .patch(location)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', '0')
      .set('upload-checksum', `sha1 ${firstChecksum}`)
      .set('content-type', 'application/offset+octet-stream')
      .send(firstChunk)
    assert.equal(first.status, 204)
    assert.equal(first.headers['upload-offset'], String(firstChunk.byteLength))

    const badChunk = png.subarray(24, 32)
    const mismatch = await owner.agent
      .patch(location)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', String(firstChunk.byteLength))
      .set('upload-checksum', `sha256 ${Buffer.alloc(32).toString('base64')}`)
      .set('content-type', 'application/offset+octet-stream')
      .send(badChunk)
    assert.equal(mismatch.status, 460)

    const inspected = await owner.agent.head(location).set('tus-resumable', '1.0.0')
    assert.equal(inspected.status, 200)
    assert.equal(inspected.headers['upload-offset'], String(firstChunk.byteLength))
    assert.equal(inspected.headers['upload-length'], String(png.byteLength))
    assert.equal(inspected.headers['upload-metadata'], metadata)

    const finalChunk = png.subarray(firstChunk.byteLength)
    const finalChecksum = createHash('sha256').update(finalChunk).digest('base64')
    const completed = await owner.agent
      .patch(location)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', String(firstChunk.byteLength))
      .set('upload-checksum', `sha256 ${finalChecksum}`)
      .set('content-type', 'application/offset+octet-stream')
      .send(finalChunk)

    assert.equal(completed.status, 204)
    assert.equal(completed.headers['upload-offset'], String(png.byteLength))
    assert.equal(completed.headers['upload-expires'], undefined)
    assert.deepEqual(database.client.prepare('select state from uploads').get(), {
      state: 'completed',
    })
    assert.deepEqual(database.client.prepare('select state, current_version from assets').get(), {
      state: 'processing',
      current_version: 1,
    })
    assert.deepEqual(database.client.prepare('select type, state from jobs').get(), {
      type: 'media.inspect',
      state: 'queued',
    })
    assert.equal(
      database.client
        .prepare("select count(*) from audit_events where action = 'asset.uploaded'")
        .pluck()
        .get(),
      1,
    )
  })

  it('rejects stale offsets and repairs bytes written before an interrupted metadata update', async () => {
    const { app, staging } = createTestApp()
    const owner = await initializeOwner(app)
    const created = await createUpload(owner.agent, owner.collection)
    const location = created.headers.location as string
    const uploadId = location.split('/').at(-1) as string

    await staging.append(uploadId, Readable.from(Buffer.from('orphan')), {
      offset: 0,
      maxBytes: png.byteLength,
    })
    const repaired = await owner.agent.head(location).set('tus-resumable', '1.0.0')
    assert.equal(repaired.status, 200)
    assert.equal(repaired.headers['upload-offset'], '0')
    assert.equal(await staging.size(uploadId), 0)

    const conflict = await owner.agent
      .patch(location)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', '1')
      .set('content-type', 'application/offset+octet-stream')
      .send(png)
    assert.equal(conflict.status, 409)
    assert.equal(await staging.size(uploadId), 0)
  })

  it('finalizes a completely staged upload during restart reconciliation', async () => {
    const { app, database, staging, tusUploads } = createTestApp()
    const owner = await initializeOwner(app)
    const created = await createUpload(owner.agent, owner.collection)
    const uploadId = (created.headers.location as string).split('/').at(-1) as string
    await staging.append(uploadId, Readable.from(png), {
      offset: 0,
      maxBytes: png.byteLength,
    })
    database.client
      .prepare("update uploads set received_bytes = ?, state = 'validating'")
      .run(png.byteLength)

    const result = await tusUploads.reconcile()

    assert.deepEqual(result, {
      inspected: 1,
      repaired: 0,
      finalized: 1,
      expired: 0,
      cleaned: 0,
      failed: 0,
    })
    assert.equal(database.client.prepare('select state from uploads').pluck().get(), 'completed')
    assert.equal(database.client.prepare('select state from assets').pluck().get(), 'processing')
    await assert.rejects(staging.size(uploadId))
  })

  it('removes a staging orphan left after a completed database commit', async () => {
    const { app, staging, tusUploads } = createTestApp()
    const owner = await initializeOwner(app)
    const created = await createUpload(owner.agent, owner.collection)
    const location = created.headers.location as string
    const uploadId = location.split('/').at(-1) as string
    const completed = await owner.agent
      .patch(location)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', '0')
      .set('content-type', 'application/offset+octet-stream')
      .send(png)
    assert.equal(completed.status, 204)
    await staging.create(uploadId)

    const result = await tusUploads.reconcile()

    assert.equal(result.cleaned, 1)
    assert.equal(result.failed, 0)
    await assert.rejects(staging.size(uploadId))
  })

  it('terminates unfinished uploads and reports retained expiration tombstones', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const terminated = await createUpload(owner.agent, owner.collection)
    const terminatedLocation = terminated.headers.location as string

    const removed = await owner.agent.delete(terminatedLocation).set('tus-resumable', '1.0.0')
    assert.equal(removed.status, 204)
    const afterTermination = await owner.agent
      .head(terminatedLocation)
      .set('tus-resumable', '1.0.0')
    assert.equal(afterTermination.status, 410)
    assert.equal(afterTermination.body.code, undefined)

    const expiring = await createUpload(owner.agent, owner.collection)
    const expiringLocation = expiring.headers.location as string
    database.client.prepare('update uploads set expires_at = ?').run(Date.now() - 1)
    const afterExpiration = await owner.agent.head(expiringLocation).set('tus-resumable', '1.0.0')
    assert.equal(afterExpiration.status, 410)
    assert.equal(
      database.client.prepare("select count(*) from uploads where state = 'expired'").pluck().get(),
      1,
    )
  })

  it('requires authentication, valid protocol headers, and safe media metadata', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)
    const anonymous = await request(app)
      .post(owner.collection)
      .set('tus-resumable', '1.0.0')
      .set('upload-length', String(png.byteLength))
      .set('upload-metadata', uploadMetadata({ filename: 'pixel.png', filetype: 'image/png' }))
      .send()
    const oldVersion = await owner.agent
      .post(owner.collection)
      .set('tus-resumable', '0.2.2')
      .set('upload-length', String(png.byteLength))
      .set('upload-metadata', uploadMetadata({ filename: 'pixel.png', filetype: 'image/png' }))
      .send()
    const unsafe = await createUpload(
      owner.agent,
      owner.collection,
      uploadMetadata({ filename: '../pixel.png', filetype: 'image/png' }),
    )

    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.headers['tus-resumable'], '1.0.0')
    assert.equal(oldVersion.status, 412)
    assert.equal(oldVersion.headers['tus-resumable'], '1.0.0')
    assert.equal(unsafe.status, 400)
  })
})
