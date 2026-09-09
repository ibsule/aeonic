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
  return { app: buildApp({ config, auth, logger: false }), database }
}

describe('authentication', () => {
  it('mounts Better Auth before the JSON body parser', async () => {
    const { app, database } = createTestApp()
    const response = await request(app).post('/api/auth/sign-up/email').send({
      name: 'Project Owner',
      email: 'owner@example.com',
      password: 'a-strong-development-password',
    })

    assert.equal(response.status, 200)
    assert.equal(response.body.user.email, 'owner@example.com')
    assert.ok(response.headers['set-cookie'])

    const account = database.client.prepare('select password from account').get() as {
      password: string
    }
    assert.notEqual(account.password, 'a-strong-development-password')
    assert.ok(account.password.length > 32)
  })

  it('creates and resolves a secure cookie session', async () => {
    const { app } = createTestApp()
    const agent = request.agent(app)
    await agent.post('/api/auth/sign-up/email').send({
      name: 'Project Owner',
      email: 'owner@example.com',
      password: 'a-strong-development-password',
    })

    const response = await agent.get('/api/auth/get-session')

    assert.equal(response.status, 200)
    assert.equal(response.body.user.email, 'owner@example.com')
    assert.ok(response.body.session.id)
  })

  it('prevents ordinary users from creating organizations outside the control plane', async () => {
    const { app } = createTestApp()
    const agent = request.agent(app)
    await agent.post('/api/auth/sign-up/email').send({
      name: 'Unassigned User',
      email: 'user@example.com',
      password: 'a-strong-development-password',
    })

    const response = await agent.post('/api/auth/organization/create').send({
      name: 'Unapproved Organization',
      slug: 'unapproved-organization',
    })

    assert.equal(response.status, 403)
  })
})
