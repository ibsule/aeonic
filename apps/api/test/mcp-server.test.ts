import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { v7 as uuidv7 } from 'uuid'
import { AgentReadToolService } from '../src/agents/tools.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { assets, assetVersions, organization, projects, user } from '../src/db/schema.js'
import { createAeonicMcpServer } from '../src/mcp.js'

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
  const assetId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'mcp@example.com' }).run()
  database.db
    .insert(organization)
    .values({ id: organizationId, name: 'Studio', slug: 'studio', createdAt: now })
    .run()
  database.db
    .insert(projects)
    .values({
      id: projectId,
      organizationId,
      name: 'Library',
      slug: 'library',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: 'hero',
      name: 'Hero',
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
  return { database, scope: { organizationId, projectId }, assetId }
}

describe('read-only MCP server', () => {
  it('advertises only bounded read tools and returns project-scoped structured data', async () => {
    const test = setup()
    const server = createAeonicMcpServer(new AgentReadToolService(test.database), test.scope)
    const client = new Client({ name: 'aeonic-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'aeonic_assets_get',
      'aeonic_assets_list',
    ])
    assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true))
    assert.ok(listed.tools.every((tool) => tool.annotations?.destructiveHint === false))

    const result = await client.callTool({
      name: 'aeonic_assets_get',
      arguments: { assetId: test.assetId },
    })
    assert.equal(result.isError, undefined)
    assert.equal(
      (result.structuredContent as { result: { asset: { id: string } } }).result.asset.id,
      test.assetId,
    )
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /storageObjectId|createdBy/)

    await client.close()
    await server.close()
  })
})
