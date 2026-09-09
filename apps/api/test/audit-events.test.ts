import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { member, organization } from '../src/db/schema.js'

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

async function initializeOwner(app: ReturnType<typeof buildApp>) {
  const setup = await request(app).post('/api/v1/setup').send({
    name: 'Audit Owner',
    email: 'audit-owner@example.com',
    password: 'a-strong-development-password',
    organizationName: 'Audit Studio',
    organizationSlug: 'audit-studio',
    projectName: 'Audit Library',
    projectSlug: 'audit-library',
  })
  const agent = request.agent(app)
  await agent.post('/api/auth/sign-in/email').send({
    email: 'audit-owner@example.com',
    password: 'a-strong-development-password',
  })
  return {
    agent,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
  }
}

describe('audit event API', () => {
  it('paginates and filters organization audit events', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)
    const created = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Campaign', slug: 'campaign' })
    assert.equal(created.status, 201)

    const first = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events?limit=1`,
    )
    assert.equal(first.status, 200)
    assert.equal(first.body.items.length, 1)
    assert.equal(first.body.items[0].action, 'project.created')
    assert.equal(typeof first.body.nextCursor, 'string')

    const second = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events?limit=1&cursor=${first.body.nextCursor}`,
    )
    assert.equal(second.status, 200)
    assert.equal(second.body.items.length, 1)
    assert.notEqual(second.body.items[0].id, first.body.items[0].id)

    const filtered = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events?projectId=${created.body.id}`,
    )
    assert.equal(filtered.status, 200)
    assert.deepEqual(
      filtered.body.items.map((event: { projectId: string }) => event.projectId),
      [created.body.id],
    )
  })

  it('restricts audit data to organization administrators', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const viewer = request.agent(app)
    const signup = await viewer.post('/api/auth/sign-up/email').send({
      name: 'Audit Viewer',
      email: 'audit-viewer@example.com',
      password: 'a-strong-development-password',
    })
    database.db
      .insert(member)
      .values({
        id: uuidv7(),
        organizationId: owner.organizationId,
        userId: signup.body.user.id as string,
        role: 'viewer',
        createdAt: new Date(),
      })
      .run()

    const viewerResult = await viewer.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events`,
    )
    assert.equal(viewerResult.status, 403)

    const otherOrganizationId = uuidv7()
    database.db
      .insert(organization)
      .values({
        id: otherOrganizationId,
        name: 'Other Studio',
        slug: 'other-studio',
        createdAt: new Date(),
      })
      .run()
    const crossTenant = await owner.agent.get(
      `/api/v1/organizations/${otherOrganizationId}/audit-events`,
    )
    assert.equal(crossTenant.status, 403)
  })

  it('rejects malformed pagination parameters', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)
    const invalidLimit = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events?limit=101`,
    )
    assert.equal(invalidLimit.status, 400)
    assert.equal(invalidLimit.body.code, 'invalid_limit')

    const invalidCursor = await owner.agent.get(
      `/api/v1/organizations/${owner.organizationId}/audit-events?cursor=not-a-cursor`,
    )
    assert.equal(invalidCursor.status, 400)
    assert.equal(invalidCursor.body.code, 'invalid_cursor')
  })
})
