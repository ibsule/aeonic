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
const storageDirectories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const storage of storageRuntimes.splice(0)) storage.close()
  for (const directory of storageDirectories.splice(0)) await rm(directory, { recursive: true })
})

function createTestApp() {
  const directory = join(tmpdir(), `aeonic-delivery-${uuidv7()}`)
  storageDirectories.push(directory)
  const config: AppConfig = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
      DELIVERY_BASE_URL: 'http://localhost:3001',
      DELIVERY_SIGNING_KEYS: `test:${Buffer.alloc(32, 7).toString('base64url')}`,
    }),
    localStoragePath: directory,
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
  return {
    agent,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
  }
}

async function upload(
  owner: Awaited<ReturnType<typeof initializeOwner>>,
  filename: string,
  content: Buffer,
  visibility: 'private' | 'public',
) {
  const response = await owner.agent
    .post(`/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/uploads`)
    .query({ filename, visibility })
    .set('content-type', 'image/png')
    .send(content)
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body as {
    assetId: string
    publicId: string
    sha256: string
    sizeBytes: number
  }
}

function markReady(database: DatabaseConnection, assetId: string): void {
  database.client.prepare("update assets set state = 'ready' where id = ?").run(assetId)
  database.client
    .prepare("update asset_versions set state = 'ready' where asset_id = ?")
    .run(assetId)
}

function publicPath(projectId: string, publicId: string, filename: string): string {
  return `/m/${projectId}/${publicId}/v1/original/${encodeURIComponent(filename)}`
}

function apiOriginalPath(owner: Awaited<ReturnType<typeof initializeOwner>>, publicId: string) {
  return `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/assets/${publicId}/versions/1/original`
}

function deliveryUrlPath(owner: Awaited<ReturnType<typeof initializeOwner>>, publicId: string) {
  return `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/assets/${publicId}/versions/1/delivery-url`
}

describe('original asset delivery', () => {
  it('serves public originals with immutable validators and HEAD parity', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const asset = await upload(owner, 'pixel.png', png, 'public')
    markReady(database, asset.assetId)
    const path = publicPath(owner.projectId, asset.publicId, 'pixel.png')

    const downloaded = await request(app).get(path)
    const head = await request(app).head(path)

    assert.equal(downloaded.status, 200)
    assert.deepEqual(downloaded.body, png)
    assert.equal(downloaded.headers['content-type'], 'image/png')
    assert.equal(downloaded.headers['content-length'], String(png.byteLength))
    assert.equal(downloaded.headers.etag, `"${asset.sha256}"`)
    assert.equal(downloaded.headers['accept-ranges'], 'bytes')
    assert.equal(downloaded.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(downloaded.headers['cross-origin-resource-policy'], 'cross-origin')
    assert.match(downloaded.headers['content-disposition'] ?? '', /^inline;/)
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], String(png.byteLength))
    assert.equal(head.text, undefined)
  })

  it('conceals private originals and serves tamper-resistant signed URLs', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const asset = await upload(owner, 'private.png', png, 'private')
    markReady(database, asset.assetId)
    const path = publicPath(owner.projectId, asset.publicId, 'private.png')

    const hidden = await request(app).get(path)
    const created = await owner.agent
      .post(deliveryUrlPath(owner, asset.publicId))
      .send({ expiresInSeconds: 600, disposition: 'attachment' })
    const signed = new URL(created.body.url as string)
    const downloaded = await request(app).get(`${signed.pathname}${signed.search}`)
    signed.searchParams.set('disposition', 'inline')
    const tampered = await request(app).get(`${signed.pathname}${signed.search}`)

    assert.equal(hidden.status, 404)
    assert.equal(created.status, 201)
    assert.match(created.headers['cache-control'] ?? '', /no-store/)
    assert.equal(downloaded.status, 200)
    assert.deepEqual(downloaded.body, png)
    assert.equal(downloaded.headers['cache-control'], 'private, no-store')
    assert.match(downloaded.headers['content-disposition'] ?? '', /^attachment;/)
    assert.equal(tampered.status, 404)
    assert.equal(
      database.client
        .prepare("select count(*) from audit_events where action = 'asset.delivery_url_created'")
        .pluck()
        .get(),
      1,
    )
  })

  it('supports conditional and single-range responses in RFC evaluation order', async () => {
    const content = Buffer.concat([png, Buffer.from('0123456789')])
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const asset = await upload(owner, 'range.png', content, 'public')
    markReady(database, asset.assetId)
    const path = publicPath(owner.projectId, asset.publicId, 'range.png')
    const etag = `"${asset.sha256}"`

    const partial = await request(app).get(path).set('range', 'bytes=2-8')
    const suffix = await request(app).get(path).set('range', 'bytes=-5')
    const notModified = await request(app)
      .get(path)
      .set('if-none-match', `W/${etag}`)
      .set('range', 'bytes=0-1')
    const ignoredRange = await request(app)
      .get(path)
      .set('range', 'bytes=0-1')
      .set('if-range', '"different"')
    const unsatisfiable = await request(app).get(path).set('range', 'bytes=0-1,4-5')

    assert.equal(partial.status, 206)
    assert.deepEqual(partial.body, content.subarray(2, 9))
    assert.equal(partial.headers['content-range'], `bytes 2-8/${content.byteLength}`)
    assert.equal(partial.headers['content-length'], '7')
    assert.equal(suffix.status, 206)
    assert.deepEqual(suffix.body, content.subarray(-5))
    assert.equal(notModified.status, 304)
    assert.equal(notModified.text, '')
    assert.equal(ignoredRange.status, 200)
    assert.deepEqual(ignoredRange.body, content)
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers['content-range'], `bytes */${content.byteLength}`)
    assert.equal(unsatisfiable.body.code, 'range_not_satisfiable')
  })

  it('requires ready state and enforces authenticated project scope', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const processing = await upload(owner, 'processing.png', png, 'public')
    const unavailable = await request(app).get(
      publicPath(owner.projectId, processing.publicId, 'processing.png'),
    )
    markReady(database, processing.assetId)

    const key = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/api-keys`)
      .send({ name: 'Reader', scopes: ['assets:read'] })
    const authenticated = await request(app)
      .get(apiOriginalPath(owner, processing.publicId))
      .set('x-api-key', key.body.secret)
    const secondProject = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Other', slug: 'other' })
    const crossProject = await request(app)
      .get(
        `/api/v1/organizations/${owner.organizationId}/projects/${secondProject.body.id}/assets/${processing.publicId}/versions/1/original`,
      )
      .set('x-api-key', key.body.secret)

    assert.equal(unavailable.status, 404)
    assert.equal(authenticated.status, 200)
    assert.equal(authenticated.headers['cache-control'], 'private, no-store')
    assert.equal(crossProject.status, 403)
  })
})
