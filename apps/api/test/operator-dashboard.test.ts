import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { assets, assetVersions, jobs } from '../src/db/schema.js'

const databases: DatabaseConnection[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

async function fixture() {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:3001',
  })
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const auth = createAuth(config, database)
  const app = buildApp({ config, auth, database, logger: false })
  const setup = await request(app)
    .post('/api/v1/setup')
    .send({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'a-strong-development-password',
      organizationName: 'Studio',
      organizationSlug: 'studio',
      projectName: 'Library',
      projectSlug: 'library',
    })
    .expect(201)
  const agent = request.agent(app)
  await agent
    .post('/api/auth/sign-in/email')
    .send({ email: 'owner@example.com', password: 'a-strong-development-password' })
    .expect(200)
  return {
    agent,
    database,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
    userId: setup.body.userId as string,
  }
}

describe('operator dashboard APIs', () => {
  it('lists, searches, reads, and safely updates project assets', async () => {
    const { agent, database, organizationId, projectId, userId } = await fixture()
    const now = new Date()
    const assetId = uuidv7()
    const publicId = uuidv7()
    const versionId = uuidv7()
    database.db
      .insert(assets)
      .values({
        id: assetId,
        organizationId,
        projectId,
        publicId,
        name: 'Campaign hero',
        folder: 'campaigns/autumn',
        mediaKind: 'image',
        visibility: 'private',
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
        organizationId,
        projectId,
        assetId,
        version: 1,
        state: 'ready',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        sha256: 'a'.repeat(64),
        width: 1200,
        height: 630,
        metadata: { colorSpace: 'srgb' },
        createdBy: userId,
        createdAt: now,
      })
      .run()
    const base = `/api/v1/organizations/${organizationId}/projects/${projectId}/assets`
    const list = await agent.get(`${base}?query=Campaign`)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.items.length, 1)
    assert.equal(list.body.items[0].version.width, 1200)
    const read = await agent.get(`${base}/${publicId}`).expect(200)
    assert.match(read.headers.etag, /^"asset-/)
    await agent.patch(`${base}/${publicId}`).send({ visibility: 'public' }).expect(428)
    const updated = await agent
      .patch(`${base}/${publicId}`)
      .set('if-match', read.headers.etag)
      .send({ name: 'Autumn hero', visibility: 'public' })
      .expect(200)
    assert.equal(updated.body.name, 'Autumn hero')
    assert.equal(updated.body.visibility, 'public')
    assert.equal(
      database.client
        .prepare("select action from audit_events where action = 'asset.updated'")
        .pluck()
        .get(),
      'asset.updated',
    )
  })

  it('exposes sanitized, project-scoped job progress and failures', async () => {
    const { agent, database, organizationId, projectId, userId } = await fixture()
    const now = new Date()
    const id = uuidv7()
    database.db
      .insert(jobs)
      .values({
        id,
        organizationId,
        projectId,
        type: 'media.derive',
        state: 'failed',
        payload: {},
        progress: 42,
        attempts: 3,
        maxAttempts: 3,
        runAfter: now,
        errorCode: 'command_failed',
        errorMessage: '/private/path/ffmpeg secret output',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      })
      .run()
    const base = `/api/v1/organizations/${organizationId}/projects/${projectId}/jobs`
    const list = await agent.get(base)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.items[0].progress, 42)
    assert.match(list.body.items[0].errorMessage, /media processor/)
    assert.doesNotMatch(JSON.stringify(list.body), /private\/path/)
    await agent.get(`${base}/${id}`).expect(200)
  })
})
