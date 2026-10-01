import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import { SqliteAgentWorkflowRepository } from '../src/agents/repository.js'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { assets, assetVersions, user } from '../src/db/schema.js'

const databases: DatabaseConnection[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

async function setup() {
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
  const app = buildApp({ config, auth, database, logger: false })
  const initialized = await request(app).post('/api/v1/setup').send({
    name: 'Workflow Owner',
    email: 'workflow-owner@example.com',
    password: 'a-strong-development-password',
    organizationName: 'Workflow Studio',
    organizationSlug: 'workflow-studio',
    projectName: 'Workflow Library',
    projectSlug: 'workflow-library',
  })
  const agent = request.agent(app)
  await agent.post('/api/auth/sign-in/email').send({
    email: 'workflow-owner@example.com',
    password: 'a-strong-development-password',
  })
  const actor = database.db.select().from(user).get()
  assert.ok(actor)
  const scope = {
    organizationId: initialized.body.organizationId as string,
    projectId: initialized.body.projectId as string,
  }
  const now = new Date()
  const assetId = uuidv7()
  const assetVersionId = uuidv7()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      ...scope,
      publicId: 'workflow-target',
      name: 'Workflow target',
      mediaKind: 'image',
      state: 'ready',
      currentVersion: 1,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assetVersions)
    .values({
      id: assetVersionId,
      ...scope,
      assetId,
      version: 1,
      state: 'ready',
      createdBy: actor.id,
      createdAt: now,
    })
    .run()
  const workflows = new SqliteAgentWorkflowRepository(database)
  const budget = {
    maxSteps: 2,
    maxWallTimeMs: 60_000,
    maxTokens: 1_000,
    maxCostMicroUsd: 1_000,
    maxAssets: 1,
    maxOutputBytes: 0,
    maxRetries: 1,
  }
  const run = workflows.createRun({
    ...scope,
    request: 'Delete the reviewed duplicate.',
    budget,
    createdBy: actor.id,
    requestId: 'api-test-create',
    now,
  })
  const frozen = workflows.freezePlanAndRequestApproval({
    ...scope,
    runId: run.id,
    plannerVersion: 'planner-v1',
    summary: 'Delete one exact duplicate.',
    riskClass: 'destructive',
    reversibility: 'irreversible',
    requiredRole: 'owner',
    calls: [
      {
        id: 'step_1',
        tool: 'assets.delete',
        arguments: { assetId },
        expectedEffect: 'Delete the reviewed asset.',
        targetIds: [assetId],
      },
    ],
    targets: [
      {
        assetId,
        assetVersionId,
        assetVersion: 1,
        assetUpdatedAt: now.toISOString(),
      },
    ],
    budget,
    estimatedCostMicroUsd: 0,
    estimatedOutputBytes: 0,
    requestedBy: actor.id,
    requestId: 'api-test-plan',
    expiresAt: new Date(now.getTime() + 60_000),
    now,
  })
  return { app, agent, scope, frozen }
}

describe('agent approval API', () => {
  it('requires a signed-in human and consumes the exact reviewed hash once', async () => {
    const test = await setup()
    const base = `/api/v1/organizations/${test.scope.organizationId}/projects/${test.scope.projectId}/agent-approvals`
    assert.equal((await request(test.app).get(base)).status, 401)

    const inbox = await test.agent.get(base)
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body))
    assert.equal(inbox.body.items.length, 1)
    assert.equal(inbox.body.items[0].plan.hash, test.frozen.plan.planHash)
    assert.deepEqual(inbox.body.items[0].plan.calls[0].targetIds, [
      test.frozen.plan.targetSnapshot[0]?.assetId,
    ])

    const approved = await test.agent
      .post(`${base}/${test.frozen.approval.id}/decision`)
      .send({ decision: 'approved', reason: 'Target and effect reviewed.' })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.state, 'approved')

    const wrongHash = await test.agent
      .post(`${base}/${test.frozen.approval.id}/execute`)
      .send({ planHash: 'f'.repeat(64) })
    assert.equal(wrongHash.status, 409)
    assert.equal(wrongHash.body.code, 'plan_mismatch')

    const executed = await test.agent
      .post(`${base}/${test.frozen.approval.id}/execute`)
      .send({ planHash: test.frozen.plan.planHash })
    assert.equal(executed.status, 202)
    assert.equal(executed.body.state, 'executing')

    const replay = await test.agent
      .post(`${base}/${test.frozen.approval.id}/execute`)
      .send({ planHash: test.frozen.plan.planHash })
    assert.equal(replay.status, 409)
    assert.equal(replay.body.code, 'approval_not_usable')
  })
})
