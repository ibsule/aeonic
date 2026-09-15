import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import type { OrganizationRole } from '../src/authorization/policy.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { member, projectMembers } from '../src/db/schema.js'

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
    name: 'Preset Owner',
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

async function addProjectUser(
  app: ReturnType<typeof buildApp>,
  database: DatabaseConnection,
  owner: Awaited<ReturnType<typeof initializeOwner>>,
  role: OrganizationRole,
) {
  const agent = request.agent(app)
  const email = `${role}@example.com`
  const signup = await agent.post('/api/auth/sign-up/email').send({
    name: role,
    email,
    password: 'a-strong-development-password',
  })
  const userId = signup.body.user.id as string
  const now = new Date()
  database.db
    .insert(member)
    .values({ id: uuidv7(), organizationId: owner.organizationId, userId, role, createdAt: now })
    .run()
  database.db
    .insert(projectMembers)
    .values({
      id: uuidv7(),
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      userId,
      createdBy: owner.userId,
      createdAt: now,
    })
    .run()
  return agent
}

function collection(owner: Awaited<ReturnType<typeof initializeOwner>>): string {
  return `/api/v1/organizations/${owner.organizationId}/projects/${owner.projectId}/transform-presets`
}

describe('transform preset control plane', () => {
  it('creates immutable canonical versions and retrieves their exact identities', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const url = collection(owner)

    const created = await owner.agent.post(url).send({
      name: 'product-card',
      transform: 'q_080,f_webp,fit_cover,h_0600,w_0800',
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.selector, 'p_product-card.v1')
    assert.equal(created.body.canonicalSpec, 'w_800,h_600,f_webp')
    assert.equal(created.headers.location, `${url}/product-card/versions/1`)

    const duplicate = await owner.agent.post(url).send({
      name: 'product-card',
      transform: 'w_400',
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.code, 'transform_preset_conflict')

    const revised = await owner.agent
      .post(`${url}/product-card/versions`)
      .send({ transform: 'h_300,w_400,f_avif,q_70' })
    assert.equal(revised.status, 201)
    assert.equal(revised.body.selector, 'p_product-card.v2')
    assert.equal(revised.body.canonicalSpec, 'w_400,h_300,f_avif,q_70')

    const unchanged = await owner.agent
      .post(`${url}/product-card/versions`)
      .send({ transform: 'q_070,f_avif,w_0400,h_0300' })
    assert.equal(unchanged.status, 409)
    assert.equal(unchanged.body.code, 'transform_preset_unchanged')

    const initial = await owner.agent.get(`${url}/product-card/versions/1`)
    assert.equal(initial.status, 200)
    assert.equal(initial.body.canonicalSpec, 'w_800,h_600,f_webp')

    const listed = await owner.agent.get(url)
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.items.map((item: { selector: string }) => item.selector),
      ['p_product-card.v2', 'p_product-card.v1'],
    )
    assert.equal(listed.body.nextCursor, null)

    const firstPage = await owner.agent.get(`${url}?limit=1`)
    assert.equal(firstPage.status, 200)
    assert.equal(firstPage.body.items[0].selector, 'p_product-card.v2')
    assert.ok(firstPage.body.nextCursor)
    const secondPage = await owner.agent.get(`${url}?limit=1&cursor=${firstPage.body.nextCursor}`)
    assert.equal(secondPage.status, 200)
    assert.equal(secondPage.body.items[0].selector, 'p_product-card.v1')
    assert.equal(secondPage.body.nextCursor, null)

    const invalidLimit = await owner.agent.get(`${url}?limit=101`)
    assert.equal(invalidLimit.status, 400)
    assert.equal(invalidLimit.body.code, 'invalid_limit')
    const invalidCursor = await owner.agent.get(`${url}?cursor=not-a-uuid`)
    assert.equal(invalidCursor.status, 400)
    assert.equal(invalidCursor.body.code, 'invalid_cursor')

    const audits = database.client
      .prepare(
        "select action from audit_events where target_type = 'transform_preset' order by created_at, id",
      )
      .pluck()
      .all()
    assert.deepEqual(audits, ['transform_preset.created', 'transform_preset.version_created'])
  })

  it('allows assigned developers to version presets while viewers remain read-only', async () => {
    const { app, database } = createTestApp()
    const owner = await initializeOwner(app)
    const developer = await addProjectUser(app, database, owner, 'developer')
    const viewer = await addProjectUser(app, database, owner, 'viewer')
    const url = collection(owner)

    const created = await developer
      .post(url)
      .send({ name: 'thumbnail', transform: 'w_320,h_180,f_auto' })
    assert.equal(created.status, 201)

    const visible = await viewer.get(url)
    assert.equal(visible.status, 200)
    assert.equal(visible.body.items[0].selector, 'p_thumbnail.v1')

    const denied = await viewer
      .post(`${url}/thumbnail/versions`)
      .send({ transform: 'w_640,h_360,f_auto' })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.code, 'access_denied')

    const malformed = await developer.post(url).send({ name: 'bad--name', transform: 'w_100' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.code, 'invalid_request')

    const unsafe = await developer
      .post(`${url}/thumbnail/versions`)
      .send({ transform: 'w_100,command_shell' })
    assert.equal(unsafe.status, 400)
    assert.equal(unsafe.body.code, 'unknown_operation')
  })
})
