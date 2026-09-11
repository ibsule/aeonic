import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { type AppConfig, loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import type { StorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'
import { UploadReconciler } from '../src/uploads/reconciler.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const databases: DatabaseConnection[] = []
const storageRuntimes: StorageRuntime[] = []
const storageDirectories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const storage of storageRuntimes.splice(0)) storage.close()
  for (const directory of storageDirectories.splice(0)) await rm(directory, { recursive: true })
})

function createTestApp(overrides: Partial<AppConfig> = {}) {
  const directory = join(tmpdir(), `aeonic-upload-${uuidv7()}`)
  storageDirectories.push(directory)
  const config: AppConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
    }),
    localStoragePath: directory,
    ...overrides,
  }
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const auth = createAuth(config, database)
  const storage = createStorageRuntime(config)
  storageRuntimes.push(storage)
  return { app: buildApp({ config, auth, database, storage, logger: false }), database, storage }
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
  return {
    agent,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
  }
}

function uploadPath(organizationId: string, projectId: string): string {
  return `/api/v1/organizations/${organizationId}/projects/${projectId}/uploads`
}

describe('simple uploads', () => {
  it('streams a valid file into a processing asset and durable inspection job', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const digest = createHash('sha256').update(png).digest('base64')

    const uploaded = await owner.agent
      .post(uploadPath(owner.organizationId, owner.projectId))
      .query({ filename: 'pixel.png', name: 'Pixel', folder: 'campaign/hero' })
      .set('content-type', 'image/png')
      .set('content-digest', `sha-256=:${digest}:`)
      .send(png)

    assert.equal(uploaded.status, 201)
    assert.equal(uploaded.body.name, 'Pixel')
    assert.equal(uploaded.body.folder, 'campaign/hero')
    assert.equal(uploaded.body.state, 'processing')
    assert.equal(uploaded.body.mimeType, 'image/png')
    assert.equal(uploaded.body.sizeBytes, png.byteLength)
    assert.match(uploaded.body.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(
      database.client
        .prepare('select state, current_version from assets where id = ?')
        .get(uploaded.body.assetId),
      { state: 'processing', current_version: 1 },
    )
    assert.deepEqual(
      database.client
        .prepare('select state, type from jobs where project_id = ?')
        .get(owner.projectId),
      { state: 'queued', type: 'media.inspect' },
    )
    assert.equal(
      database.client
        .prepare("select count(*) from audit_events where action = 'asset.uploaded'")
        .pluck()
        .get(),
      1,
    )
  })

  it('replays completed idempotent uploads without duplicating assets', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const path = uploadPath(owner.organizationId, owner.projectId)
    const first = await owner.agent
      .post(path)
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .set('idempotency-key', 'pixel-upload-0001')
      .send(png)
    const replay = await owner.agent
      .post(path)
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .set('idempotency-key', 'pixel-upload-0001')
      .send(png)

    assert.equal(first.status, 201)
    assert.equal(replay.status, 200)
    assert.equal(replay.headers['idempotency-replayed'], 'true')
    assert.equal(replay.body.uploadId, first.body.uploadId)
    assert.equal(database.client.prepare('select count(*) from assets').pluck().get(), 1)
  })

  it('rejects mismatched content and removes the stored object', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const uploaded = await owner.agent
      .post(uploadPath(owner.organizationId, owner.projectId))
      .query({ filename: 'not-a-pdf.pdf' })
      .set('content-type', 'application/pdf')
      .send(png)

    assert.equal(uploaded.status, 415)
    assert.equal(uploaded.body.code, 'media_type_mismatch')
    assert.equal(database.client.prepare('select state from uploads').pluck().get(), 'rejected')
    assert.equal(
      database.client.prepare('select state from storage_objects').pluck().get(),
      'deleted',
    )
  })

  it('rejects anonymous requests, unsafe filenames, and incorrect checksums', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const path = uploadPath(owner.organizationId, owner.projectId)
    const anonymous = await request(app)
      .post(path)
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .send(png)
    const unsafe = await owner.agent
      .post(path)
      .query({ filename: '../pixel.png' })
      .set('content-type', 'image/png')
      .send(png)
    const checksum = await owner.agent
      .post(path)
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .set('content-digest', `sha-256=:${Buffer.alloc(32).toString('base64')}:`)
      .send(png)

    assert.equal(anonymous.status, 401)
    assert.equal(unsafe.status, 400)
    assert.equal(unsafe.body.code, 'invalid_filename')
    assert.equal(checksum.status, 422)
    assert.equal(checksum.body.code, 'checksum_mismatch')
    assert.equal(database.client.prepare('select count(*) from uploads').pluck().get(), 1)
    assert.equal(
      database.client
        .prepare("select count(*) from audit_events where action = 'upload.rejected'")
        .pluck()
        .get(),
      1,
    )
  })

  it('enforces project quota before reading a second file', async () => {
    const paddedPng = Buffer.concat([png, Buffer.alloc(600_000 - png.byteLength)])
    const { app, database } = createTestApp({ projectStorageQuotaBytes: 1_048_576 })
    const owner = await initializeOwner(app)
    const path = uploadPath(owner.organizationId, owner.projectId)
    const first = await owner.agent
      .post(path)
      .query({ filename: 'first.png' })
      .set('content-type', 'image/png')
      .send(paddedPng)
    const second = await owner.agent
      .post(path)
      .query({ filename: 'second.png' })
      .set('content-type', 'image/png')
      .send(paddedPng)

    assert.equal(first.status, 201)
    assert.equal(second.status, 413)
    assert.equal(second.body.code, 'project_storage_quota_exceeded')
    assert.equal(database.client.prepare('select count(*) from uploads').pluck().get(), 1)
  })

  it('accepts scoped write API keys and rejects keys from another project', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const key = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/api-keys`)
      .send({ name: 'Uploader', scopes: ['assets:write'] })
    const secondProject = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Other', slug: 'other' })

    const uploaded = await request(app)
      .post(uploadPath(owner.organizationId, owner.projectId))
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .set('x-api-key', key.body.secret)
      .send(png)
    const denied = await request(app)
      .post(uploadPath(owner.organizationId, secondProject.body.id))
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .set('x-api-key', key.body.secret)
      .send(png)

    assert.equal(uploaded.status, 201)
    assert.equal(denied.status, 403)
    assert.deepEqual(
      database.client
        .prepare("select actor_type, actor_id from audit_events where action = 'asset.uploaded'")
        .get(),
      { actor_type: 'api_key', actor_id: key.body.id },
    )
  })

  it('fails and removes interrupted uploads during startup reconciliation', async () => {
    const { app, database, storage } = createTestApp()
    const owner = await initializeOwner(app)
    const uploaded = await owner.agent
      .post(uploadPath(owner.organizationId, owner.projectId))
      .query({ filename: 'pixel.png' })
      .set('content-type', 'image/png')
      .send(png)
    assert.equal(uploaded.status, 201)

    const old = Date.now() - 2 * 60 * 60 * 1_000
    database.client
      .prepare("update uploads set state = 'receiving', updated_at = ?, completed_at = null")
      .run(old)
    database.client.prepare("update assets set state = 'uploading', updated_at = ?").run(old)
    database.client.prepare("update asset_versions set state = 'uploading'").run()
    database.client
      .prepare("update storage_objects set state = 'staging', updated_at = ?, finalized_at = null")
      .run(old)
    const object = database.client.prepare('select object_key from storage_objects').get() as {
      object_key: StorageObjectKey
    }

    const result = await new UploadReconciler(database, storage).reconcile(
      new Date(Date.now() - 60 * 60 * 1_000),
    )

    assert.deepEqual(result, { inspected: 1, cleaned: 1, cleanupFailed: 0 })
    assert.equal(database.client.prepare('select state from uploads').pluck().get(), 'failed')
    assert.equal(database.client.prepare('select state from assets').pluck().get(), 'failed')
    assert.equal(
      database.client.prepare('select state from storage_objects').pluck().get(),
      'deleted',
    )
    await assert.rejects(
      storage.port.head(
        { organizationId: owner.organizationId, projectId: owner.projectId },
        object.object_key,
      ),
    )
  })
})
