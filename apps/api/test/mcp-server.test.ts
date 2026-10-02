import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { v7 as uuidv7 } from 'uuid'
import { AgentPlannerService } from '../src/agents/planner.js'
import { SqliteAgentWorkflowRepository } from '../src/agents/repository.js'
import { AgentReadToolService } from '../src/agents/tools.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  agentPlans,
  agentRuns,
  assets,
  assetVersions,
  member,
  organization,
  projects,
  user,
} from '../src/db/schema.js'
import { createAeonicMcpServer } from '../src/mcp.js'
import { ProjectService } from '../src/projects/service.js'

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
    .insert(member)
    .values({ id: uuidv7(), organizationId, userId, role: 'owner', createdAt: now })
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
  return { database, scope: { organizationId, projectId }, assetId, userId }
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

describe('approval-request MCP tool', () => {
  it('freezes one replay-safe plan without mutating the asset', async () => {
    const test = setup()
    const repository = new SqliteAgentWorkflowRepository(test.database)
    const server = createAeonicMcpServer(new AgentReadToolService(test.database), test.scope, {
      planner: new AgentPlannerService(
        test.database,
        repository,
        new ProjectService(test.database),
      ),
      actorId: test.userId,
    })
    const client = new Client({ name: 'aeonic-approval-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const listed = await client.listTools()
    const requestTool = listed.tools.find(
      (tool) => tool.name === 'aeonic_request_asset_metadata_update',
    )
    assert.equal(requestTool?.annotations?.readOnlyHint, false)
    assert.equal(requestTool?.annotations?.destructiveHint, false)
    assert.equal(requestTool?.annotations?.idempotentHint, true)

    const request = {
      name: 'aeonic_request_asset_metadata_update',
      arguments: {
        assetId: test.assetId,
        name: 'Reviewed hero',
        reason: 'Prepare an exact plan for operator approval.',
        idempotencyKey: 'mcp-metadata-0001',
      },
    }
    const first = await client.callTool(request)
    const replay = await client.callTool(request)
    const firstOutput = first.structuredContent as {
      mutationExecuted: boolean
      approvalId: string
      planId: string
    }
    const replayOutput = replay.structuredContent as { approvalId: string; planId: string }
    assert.equal(firstOutput.mutationExecuted, false)
    assert.equal(replayOutput.approvalId, firstOutput.approvalId)
    assert.equal(replayOutput.planId, firstOutput.planId)
    assert.equal(test.database.db.select().from(agentRuns).all().length, 1)
    assert.equal(test.database.db.select().from(agentPlans).all().length, 1)
    assert.equal(test.database.db.select({ name: assets.name }).from(assets).get()?.name, 'Hero')

    await client.close()
    await server.close()
  })
})
