import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { member } from '../src/db/schema.js'

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
    userId: setup.body.userId as string,
  }
}

describe('project control plane', () => {
  it('creates, lists, updates, and deletes projects with audit records', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)

    const created = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Campaign', slug: 'campaign' })
    assert.equal(created.status, 201)
    const createdEtag = created.headers.etag
    assert.ok(createdEtag)

    const listed = await owner.agent.get(`/api/v1/organizations/${owner.organizationId}/projects`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, 2)

    const updated = await owner.agent
      .patch(`/api/v1/organizations/${owner.organizationId}/projects/${created.body.id}`)
      .set('if-match', createdEtag)
      .send({ name: 'Updated Campaign' })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.version, 2)

    const stale = await owner.agent
      .patch(`/api/v1/organizations/${owner.organizationId}/projects/${created.body.id}`)
      .set('if-match', createdEtag)
      .send({ name: 'Stale Update' })
    assert.equal(stale.status, 412)
    assert.equal(stale.body.code, 'etag_mismatch')

    const updatedEtag = updated.headers.etag
    assert.ok(updatedEtag)
    const removed = await owner.agent
      .delete(`/api/v1/organizations/${owner.organizationId}/projects/${created.body.id}`)
      .set('if-match', updatedEtag)
    assert.equal(removed.status, 204)

    const auditActions = database.client
      .prepare("select action from audit_events where action like 'project.%' order by created_at")
      .pluck()
      .all()
    assert.deepEqual(auditActions, ['project.created', 'project.updated', 'project.deleted'])
  })

  it('requires authentication and organization membership', async () => {
    const { app } = createTestApp()
    const owner = await initializeOwner(app)

    const anonymous = await request(app).get(
      `/api/v1/organizations/${owner.organizationId}/projects`,
    )
    assert.equal(anonymous.status, 401)

    const outsider = request.agent(app)
    await outsider.post('/api/auth/sign-up/email').send({
      name: 'Outsider',
      email: 'outsider@example.com',
      password: 'a-strong-development-password',
    })
    const denied = await outsider.get(`/api/v1/organizations/${owner.organizationId}/projects`)
    assert.equal(denied.status, 403)
  })

  it('limits viewer access to assigned projects and denies mutations', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const second = await owner.agent
      .post(`/api/v1/organizations/${owner.organizationId}/projects`)
      .send({ name: 'Private Project', slug: 'private-project' })

    const viewer = request.agent(app)
    const signup = await viewer.post('/api/auth/sign-up/email').send({
      name: 'Viewer',
      email: 'viewer@example.com',
      password: 'a-strong-development-password',
    })
    const viewerId = signup.body.user.id as string
    const now = new Date()
    database.db
      .insert(member)
      .values({
        id: uuidv7(),
        organizationId: owner.organizationId,
        userId: viewerId,
        role: 'viewer',
        createdAt: now,
      })
      .run()
    const membersUrl = `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/members`
    const assigned = await owner.agent.post(membersUrl).send({ userId: viewerId })
    assert.equal(assigned.status, 201)
    assert.equal(assigned.body.role, 'viewer')

    const members = await owner.agent.get(membersUrl)
    assert.equal(members.status, 200)
    assert.ok(members.body.items.some((item: { userId: string }) => item.userId === viewerId))

    const listed = await viewer.get(`/api/v1/organizations/${owner.organizationId}/projects`)
    assert.deepEqual(
      listed.body.items.map((project: { id: string }) => project.id),
      [owner.projectId],
    )

    const unassigned = await viewer.get(
      `/api/v1/organizations/${owner.organizationId}/projects/${second.body.id}`,
    )
    assert.equal(unassigned.status, 403)

    const mutation = await viewer
      .patch(`/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}`)
      .set('if-match', '"irrelevant"')
      .send({ name: 'Forbidden' })
    assert.equal(mutation.status, 403)

    const removed = await owner.agent.delete(`${membersUrl}/${viewerId}`)
    assert.equal(removed.status, 204)
    const noLongerAssigned = await viewer.get(
      `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}`,
    )
    assert.equal(noLongerAssigned.status, 403)
  })
})
