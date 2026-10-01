import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { AgentPlanBudget, AgentTargetSnapshot, AgentToolCall } from '@aeonic/contracts'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  AgentWorkflowConflictError,
  calculateStoredPlanHash,
  SqliteAgentWorkflowRepository,
} from '../src/agents/repository.js'
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
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'agents@example.com' }).run()
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
  const assetVersionId = uuidv7()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: 'duplicate',
      name: 'Duplicate',
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
      id: assetVersionId,
      organizationId,
      projectId,
      assetId,
      version: 1,
      state: 'ready',
      createdBy: userId,
      createdAt: now,
    })
    .run()
  return {
    database,
    repository: new SqliteAgentWorkflowRepository(database),
    now,
    userId,
    scope: { organizationId, projectId },
    otherScope: { organizationId: otherOrganizationId, projectId: otherProjectId },
    assetId,
    assetVersionId,
  }
}

const budget: AgentPlanBudget = {
  maxSteps: 5,
  maxWallTimeMs: 60_000,
  maxTokens: 10_000,
  maxCostMicroUsd: 10_000,
  maxAssets: 10,
  maxOutputBytes: 1_000_000,
  maxRetries: 1,
}

function planParts(
  assetId: string,
  assetVersionId: string,
  assetUpdatedAt = '2026-10-01T10:00:00.000Z',
): { calls: AgentToolCall[]; targets: AgentTargetSnapshot[] } {
  return {
    calls: [
      {
        id: 'step_1',
        tool: 'assets.delete',
        arguments: { assetId },
        expectedEffect: 'Delete one asset.',
        targetIds: [assetId],
      },
    ],
    targets: [
      {
        assetId,
        assetVersionId,
        assetVersion: 1,
        assetUpdatedAt,
      },
    ],
  }
}

describe('durable agent approval workflow', () => {
  it('freezes a tenant-scoped plan and consumes an owner approval exactly once', () => {
    const test = setup()
    const run = test.repository.createRun({
      ...test.scope,
      request: 'Delete the selected duplicate.',
      budget,
      createdBy: test.userId,
      now: test.now,
    })
    const parts = planParts(test.assetId, test.assetVersionId)
    const frozen = test.repository.freezePlanAndRequestApproval({
      ...test.scope,
      runId: run.id,
      plannerVersion: 'planner-v1',
      summary: 'Delete one exact duplicate asset.',
      riskClass: 'destructive',
      reversibility: 'irreversible',
      requiredRole: 'owner',
      ...parts,
      budget,
      estimatedCostMicroUsd: 0,
      estimatedOutputBytes: 0,
      requestedBy: test.userId,
      expiresAt: new Date(test.now.getTime() + 15 * 60_000),
      now: test.now,
    })

    assert.equal(calculateStoredPlanHash(frozen.plan), frozen.plan.planHash)
    assert.equal(test.repository.findPlan(test.otherScope, frozen.plan.id), null)
    assert.equal(test.repository.listPendingApprovals(test.scope, test.now).length, 1)
    assert.throws(
      () =>
        test.repository.decideApproval(
          test.scope,
          frozen.approval.id,
          'approved',
          { id: test.userId, role: 'admin' },
          test.now,
        ),
      (error: unknown) =>
        error instanceof AgentWorkflowConflictError && error.code === 'approval_role_required',
    )

    test.repository.decideApproval(
      test.scope,
      frozen.approval.id,
      'approved',
      { id: test.userId, role: 'owner' },
      test.now,
      'Confirmed exact target.',
    )
    assert.throws(
      () =>
        test.repository.consumeApproval(test.scope, frozen.approval.id, 'f'.repeat(64), test.now),
      (error: unknown) =>
        error instanceof AgentWorkflowConflictError && error.code === 'plan_mismatch',
    )

    const consumed = test.repository.consumeApproval(
      test.scope,
      frozen.approval.id,
      frozen.plan.planHash,
      test.now,
    )
    assert.equal(consumed.approval.state, 'consumed')
    assert.equal(test.repository.findRun(test.scope, run.id)?.state, 'executing')
    assert.throws(
      () =>
        test.repository.consumeApproval(
          test.scope,
          frozen.approval.id,
          frozen.plan.planHash,
          test.now,
        ),
      (error: unknown) =>
        error instanceof AgentWorkflowConflictError && error.code === 'approval_not_usable',
    )
  })

  it('expires pending approvals before they can be decided', () => {
    const test = setup()
    const run = test.repository.createRun({
      ...test.scope,
      request: 'Update selected assets.',
      budget,
      createdBy: test.userId,
      now: test.now,
    })
    const frozen = test.repository.freezePlanAndRequestApproval({
      ...test.scope,
      runId: run.id,
      plannerVersion: 'planner-v1',
      summary: 'Update one asset.',
      riskClass: 'standard',
      reversibility: 'reversible',
      requiredRole: 'admin',
      ...planParts(test.assetId, test.assetVersionId),
      budget,
      estimatedCostMicroUsd: 0,
      estimatedOutputBytes: 0,
      requestedBy: test.userId,
      expiresAt: new Date(test.now.getTime() + 1_000),
      now: test.now,
    })
    const later = new Date(test.now.getTime() + 1_001)
    assert.deepEqual(test.repository.listPendingApprovals(test.scope, later), [])
    assert.throws(
      () =>
        test.repository.decideApproval(
          test.scope,
          frozen.approval.id,
          'approved',
          { id: test.userId, role: 'owner' },
          later,
        ),
      (error: unknown) =>
        error instanceof AgentWorkflowConflictError && error.code === 'approval_not_pending',
    )
  })

  it('refuses execution when an approved target changed after review', () => {
    const test = setup()
    const run = test.repository.createRun({
      ...test.scope,
      request: 'Delete the selected duplicate.',
      budget,
      createdBy: test.userId,
      now: test.now,
    })
    const frozen = test.repository.freezePlanAndRequestApproval({
      ...test.scope,
      runId: run.id,
      plannerVersion: 'planner-v1',
      summary: 'Delete one exact duplicate asset.',
      riskClass: 'destructive',
      reversibility: 'irreversible',
      requiredRole: 'owner',
      ...planParts(test.assetId, test.assetVersionId),
      budget,
      estimatedCostMicroUsd: 0,
      estimatedOutputBytes: 0,
      requestedBy: test.userId,
      expiresAt: new Date(test.now.getTime() + 15 * 60_000),
      now: test.now,
    })
    test.repository.decideApproval(
      test.scope,
      frozen.approval.id,
      'approved',
      { id: test.userId, role: 'owner' },
      test.now,
    )
    test.database.db
      .update(assets)
      .set({ updatedAt: new Date(test.now.getTime() + 1) })
      .where(eq(assets.id, test.assetId))
      .run()

    assert.throws(
      () =>
        test.repository.consumeApproval(
          test.scope,
          frozen.approval.id,
          frozen.plan.planHash,
          test.now,
        ),
      (error: unknown) =>
        error instanceof AgentWorkflowConflictError && error.code === 'target_snapshot_changed',
    )
    assert.equal(test.repository.findRun(test.scope, run.id)?.state, 'awaiting_approval')
  })
})
