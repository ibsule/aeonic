import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'

const databases: DatabaseConnection[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createTestApp() {
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
  return { app: buildApp({ config, auth, database, logger: false }), database }
}

const setupRequest = {
  name: 'Project Owner',
  email: 'owner@example.com',
  password: 'a-strong-development-password',
  organizationName: 'Example Studio',
  organizationSlug: 'example-studio',
  projectName: 'Media Library',
  projectSlug: 'media-library',
}

describe('initial setup', () => {
  it('atomically creates the owner, organization, project, and audit event', async () => {
    const { app, database } = createTestApp()
    const before = await request(app).get('/api/v1/setup')
    assert.deepEqual(before.body, { status: 'required' })

    const response = await request(app).post('/api/v1/setup').send(setupRequest)

    assert.equal(response.status, 201)
    assert.match(response.body.userId, /^[0-9a-f-]{36}$/)
    assert.equal(database.client.prepare('select role from member').pluck().get(), 'owner')
    assert.equal(
      database.client.prepare('select action from audit_events').pluck().get(),
      'system.setup.completed',
    )
    const after = await request(app).get('/api/v1/setup')
    assert.deepEqual(after.body, { status: 'complete' })
  })

  it('permits exactly one winner across concurrent setup requests', async () => {
    const { app, database } = createTestApp()
    const responses = await Promise.all([
      request(app).post('/api/v1/setup').send(setupRequest),
      request(app)
        .post('/api/v1/setup')
        .send({ ...setupRequest, email: 'other@example.com' }),
    ])

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409])
    assert.equal(database.client.prepare('select count(*) from user').pluck().get(), 1)
    assert.equal(database.client.prepare('select count(*) from organization').pluck().get(), 1)
    assert.equal(database.client.prepare('select count(*) from projects').pluck().get(), 1)
  })

  it('rejects invalid input without changing setup state', async () => {
    const { app, database } = createTestApp()
    const response = await request(app)
      .post('/api/v1/setup')
      .send({ ...setupRequest, projectSlug: '../escape' })

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'invalid_request')
    assert.equal(database.client.prepare('select count(*) from user').pluck().get(), 0)
  })

  it('creates credentials compatible with Better Auth sign-in', async () => {
    const { app } = createTestApp()
    await request(app).post('/api/v1/setup').send(setupRequest).expect(201)

    const response = await request(app).post('/api/auth/sign-in/email').send({
      email: setupRequest.email,
      password: setupRequest.password,
    })

    assert.equal(response.status, 200)
    assert.equal(response.body.user.email, setupRequest.email)
    assert.ok(response.headers['set-cookie'])
  })
})
