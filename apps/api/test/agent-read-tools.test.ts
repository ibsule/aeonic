import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { AgentPolicyError } from '../src/agents/policy.js'
import { AgentReadToolService } from '../src/agents/tools.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { assets, assetVersions, organization, projects, user } from '../src/db/schema.js'

const databases: DatabaseConnection[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup() {
  const database = openDatabase(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }))
  databases.push(database)
  database.migrate()
  const now = new Date('2026-10-01T10:00:00.000Z')
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const otherOrganizationId = uuidv7()
  const otherProjectId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'tools@example.com' }).run()
  database.db
    .insert(organization)
    .values([
      { id: organizationId, name: 'Studio', slug: 'studio', createdAt: now },
      { id: otherOrganizationId, name: 'Other', slug: 'other', createdAt: now },
    ])
    .run()
  database.db
    .insert(projects)
    .values([
      {
        id: projectId,
        organizationId,
        name: 'Library',
        slug: 'library',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherProjectId,
        organizationId: otherOrganizationId,
        name: 'Other',
        slug: 'other',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run()
  const assetId = uuidv7()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: 'hero-image',
      name: 'Hero image',
      mediaKind: 'image',
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
      id: uuidv7(),
      organizationId,
      projectId,
      assetId,
      version: 1,
      state: 'ready',
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  return {
    service: new AgentReadToolService(database),
    assetId,
    scope: { organizationId, projectId },
    otherScope: { organizationId: otherOrganizationId, projectId: otherProjectId },
  }
}

describe('typed agent read tools', () => {
  it('returns bounded project data and current version details', () => {
    const test = setup()
    const listed = test.service.execute(test.scope, 'assets.list', { limit: 10 })
    assert.equal((listed.data as unknown[]).length, 1)
    const found = test.service.execute(test.scope, 'assets.get', { assetId: test.assetId })
    assert.equal((found.data as { asset: { id: string } }).asset.id, test.assetId)
    assert.equal((found.data as { version: { mimeType: string } }).version.mimeType, 'image/jpeg')
  })

  it('fails closed and never crosses tenant scope', () => {
    const test = setup()
    assert.equal(
      test.service.execute(test.otherScope, 'assets.get', { assetId: test.assetId }).data,
      null,
    )
    assert.deepEqual(test.service.execute(test.otherScope, 'assets.list', {}).data, [])
    assert.throws(
      () => test.service.execute(test.scope, 'shell.run', {}),
      (error: unknown) => error instanceof AgentPolicyError && error.code === 'unknown_tool',
    )
    assert.throws(
      () => test.service.execute(test.scope, 'assets.list', { limit: 101 }),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === 'invalid_tool_arguments',
    )
  })
})
