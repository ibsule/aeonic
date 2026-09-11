import assert from 'node:assert/strict'
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
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'

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

function metadata(): string {
  return [
    `filename ${Buffer.from('reserved.png').toString('base64')}`,
    `filetype ${Buffer.from('image/png').toString('base64')}`,
  ].join(',')
}

function createTestApp() {
  const directory = join(tmpdir(), `aeonic-storage-overview-${uuidv7()}`)
  directories.push(directory)
  const config: AppConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
    }),
    localStoragePath: join(directory, 'objects'),
    tusStoragePath: join(directory, 'tus'),
    projectStorageQuotaBytes: 1024 * 1024,
  }
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const auth = createAuth(config, database)
  const storage = createStorageRuntime(config)
  storageRuntimes.push(storage)
  return { app: buildApp({ config, auth, database, storage, logger: false }), database }
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
  const root = `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}`
  return {
    agent,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
    root,
  }
}

describe('project storage overview', () => {
  it('reports authoritative stored and reserved usage with sanitized health data', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)
    const simple = await owner.agent
      .post(`${owner.root}/uploads`)
      .query({ filename: 'stored.png' })
      .set('content-type', 'image/png')
      .send(png)
    const resumable = await owner.agent
      .post(`${owner.root}/tus`)
      .set('tus-resumable', '1.0.0')
      .set('upload-length', String(png.byteLength * 2))
      .set('upload-metadata', metadata())
      .send()
    assert.equal(simple.status, 201)
    assert.equal(resumable.status, 201)

    const overview = await owner.agent.get(`${owner.root}/storage`)

    assert.equal(overview.status, 200)
    assert.equal(overview.headers['cache-control'], 'no-store')
    assert.equal(overview.body.backend, 'local')
    assert.equal(overview.body.health.status, 'available')
    assert.equal(overview.body.health.writable, true)
    assert.match(overview.body.health.capacity.totalBytes, /^[0-9]+$/)
    assert.equal(overview.body.usage.usedBytes, png.byteLength)
    assert.equal(overview.body.usage.reservedBytes, png.byteLength * 2)
    assert.equal(overview.body.usage.quotaRemainingBytes, 1024 * 1024 - png.byteLength * 3)
    assert.deepEqual(overview.body.objects, { available: 1, staging: 1, failed: 0 })
    assert.deepEqual(overview.body.uploads, { active: 1, failed: 0, rejected: 0, expired: 0 })
    assert.deepEqual(overview.body.failures, [])
  })

  it('groups stable failure codes and enforces project isolation for users and API keys', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    await owner.agent
      .post(`${owner.root}/uploads`)
      .query({ filename: 'broken.pdf' })
      .set('content-type', 'application/pdf')
      .send(png)
    database.client
      .prepare("update storage_objects set state = 'failed', error_code = 'cleanup_failed'")
      .run()
    const second = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Second', slug: 'second' })
    const key = await owner.agent
      .post(`${owner.root}/api-keys`)
      .send({ name: 'Storage reader', scopes: ['assets:read'] })

    const overview = await request(app)
      .get(`${owner.root}/storage`)
      .set('x-api-key', key.body.secret)
    const isolated = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/projects/${second.body.id}/storage`,
    )
    const denied = await request(app)
      .get(`/api/v1/organizations/${owner.organizationId}/projects/${second.body.id}/storage`)
      .set('x-api-key', key.body.secret)

    assert.equal(overview.status, 200)
    assert.deepEqual(overview.body.failures, [
      { source: 'object', code: 'cleanup_failed', count: 1 },
      { source: 'upload', code: 'media_type_mismatch', count: 1 },
    ])
    assert.equal(isolated.status, 200)
    assert.equal(isolated.body.usage.usedBytes, 0)
    assert.deepEqual(isolated.body.failures, [])
    assert.equal(denied.status, 403)
  })
})
