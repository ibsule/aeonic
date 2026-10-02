import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { AgentToolExecutionHandler } from '../src/agents/execution-handler.js'
import { AgentPlannerService } from '../src/agents/planner.js'
import { SqliteAgentWorkflowRepository } from '../src/agents/repository.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  agentRuns,
  assets,
  assetVersions,
  auditEvents,
  jobs,
  member,
  organization,
  projects,
  toolExecutions,
  user,
} from '../src/db/schema.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobRunner } from '../src/jobs/runner.js'
import { ProjectService } from '../src/projects/service.js'

const databases: DatabaseConnection[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup() {
  const database = openDatabase(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }))
  databases.push(database)
  database.migrate()
  const plannedAt = new Date('2026-10-02T10:00:00.000Z')
  const executedAt = new Date('2026-10-02T10:00:01.000Z')
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const assetId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'worker@example.com' }).run()
  database.db
    .insert(organization)
    .values({ id: organizationId, name: 'Studio', slug: 'studio', createdAt: plannedAt })
    .run()
  database.db
    .insert(member)
    .values({ id: uuidv7(), organizationId, userId, role: 'owner', createdAt: plannedAt })
    .run()
  database.db
    .insert(projects)
    .values({
      id: projectId,
      organizationId,
      name: 'Library',
      slug: 'library',
      createdBy: userId,
      createdAt: plannedAt,
      updatedAt: plannedAt,
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
      createdAt: plannedAt,
      updatedAt: plannedAt,
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
      createdBy: userId,
      createdAt: plannedAt,
    })
    .run()
  const scope = { organizationId, projectId }
  const repository = new SqliteAgentWorkflowRepository(database)
  const frozen = new AgentPlannerService(
    database,
    repository,
    new ProjectService(database),
  ).requestAssetMetadataUpdate(
    userId,
    scope,
    {
      assetId,
      name: 'Reviewed hero',
      visibility: 'public',
      reason: 'Apply the metadata reviewed by the operator.',
      idempotencyKey: 'execution-test-0001',
    },
    'request-plan',
    plannedAt,
  )
  repository.decideApproval(
    scope,
    frozen.approval.id,
    'approved',
    { id: userId, role: 'owner' },
    plannedAt,
    'Exact target reviewed.',
  )
  repository.consumeApproval(
    scope,
    frozen.approval.id,
    frozen.plan.planHash,
    plannedAt,
    userId,
    'request-execute',
  )
  const handler = new AgentToolExecutionHandler(database, repository, () => executedAt)
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([['agent.execute_tool', handler.handle]]),
    {
      workerId: 'worker:test',
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      timeoutMs: 20_000,
      pollMs: 100,
      now: () => executedAt,
    },
  )
  return { database, runner, scope, assetId, runId: frozen.plan.runId, executedAt }
}

describe('approved agent tool execution', () => {
  it('revalidates and atomically applies the exact approved metadata change', async () => {
    const test = setup()
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')

    const asset = test.database.db.select().from(assets).where(eq(assets.id, test.assetId)).get()
    assert.equal(asset?.name, 'Reviewed hero')
    assert.equal(asset?.visibility, 'public')
    assert.equal(asset?.updatedAt.toISOString(), test.executedAt.toISOString())
    assert.equal(
      test.database.db.select().from(agentRuns).where(eq(agentRuns.id, test.runId)).get()?.state,
      'succeeded',
    )
    assert.equal(test.database.db.select().from(toolExecutions).get()?.state, 'succeeded')
    assert.equal(test.database.db.select().from(jobs).get()?.state, 'succeeded')
    assert.deepEqual(
      test.database.db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .all()
        .map((event) => event.action)
        .slice(-2),
      ['asset.updated_by_agent', 'agent.tool_succeeded'],
    )
  })

  it('fails closed when the approved target changes before the worker runs', async () => {
    const test = setup()
    test.database.db
      .update(assets)
      .set({ name: 'Changed elsewhere', updatedAt: test.executedAt })
      .where(eq(assets.id, test.assetId))
      .run()

    assert.equal(await test.runner.runOnce(new AbortController().signal), 'failed')
    assert.equal(
      test.database.db.select().from(assets).where(eq(assets.id, test.assetId)).get()?.name,
      'Changed elsewhere',
    )
    assert.equal(
      test.database.db.select().from(toolExecutions).get()?.errorCode,
      'target_snapshot_changed',
    )
    assert.equal(
      test.database.db.select().from(agentRuns).where(eq(agentRuns.id, test.runId)).get()?.state,
      'failed',
    )
  })
})
