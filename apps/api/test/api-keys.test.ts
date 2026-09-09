import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { createAuth, type AuthService } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'

const databases: DatabaseConnection[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createTestApp(): {
  app: ReturnType<typeof buildApp>
  auth: AuthService
  database: DatabaseConnection
} {
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
  return { app: buildApp({ config, auth, database, logger: false }), auth, database }
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

describe('project API keys', () => {
  it('creates a one-time secret backed by a project-scoped hash', async () => {
    const { app, auth, database } = createTestApp()
    const owner = await initializeOwner(app)
    const collection = `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/api-keys`

    const created = await owner.agent.post(collection).send({
      name: 'Delivery client',
      scopes: ['projects:read', 'assets:read'],
      expiresInSeconds: 3_600,
    })

    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.match(created.body.secret, /^aek_/)
    assert.deepEqual(created.body.scopes, ['projects:read', 'assets:read'])
    const storedHash = database.client.prepare('select key from apikey').pluck().get()
    assert.notEqual(storedHash, created.body.secret)

    const verified = await auth.verifyApiKey(created.body.secret)
    assert.equal(verified?.organizationId, owner.organizationId)
    assert.equal(verified?.projectId, owner.projectId)

    const listed = await owner.agent.get(collection)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, 1)
    assert.equal(listed.body.items[0].secret, undefined)

    const revoked = await owner.agent.delete(`${collection}/${created.body.id}`)
    assert.equal(revoked.status, 204)
    assert.equal(await auth.verifyApiKey(created.body.secret), null)

    const actions = database.client
      .prepare("select action from audit_events where action like 'api_key.%' order by created_at")
      .pluck()
      .all()
    assert.deepEqual(actions, ['api_key.created', 'api_key.revoked'])
  })

  it('rejects unsupported scopes', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)
    const response = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/api-keys`)
      .send({ name: 'Overpowered key', scopes: ['organizations:delete'] })

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'invalid_request')
  })
})
