import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentPlanBudget, AgentTargetSnapshot, AgentToolCall } from '@aeonic/contracts'
import { v7 as uuidv7 } from 'uuid'
import {
  AgentPolicyError,
  canonicalPlanJson,
  evaluateAgentPlan,
  hashAgentPlan,
  type AgentToolPolicy,
} from '../src/agents/policy.js'

const budget: AgentPlanBudget = {
  maxSteps: 5,
  maxWallTimeMs: 60_000,
  maxTokens: 10_000,
  maxCostMicroUsd: 20_000,
  maxAssets: 10,
  maxOutputBytes: 1_000_000,
  maxRetries: 1,
}

const target: AgentTargetSnapshot = {
  assetId: uuidv7(),
  assetVersionId: uuidv7(),
  assetVersion: 1,
  assetUpdatedAt: '2026-10-01T10:00:00.000Z',
}

const readPolicy: AgentToolPolicy = {
  name: 'assets.get',
  access: 'read',
  riskClass: 'standard',
  reversibility: 'reversible',
  requiredRole: 'admin',
  maximumTargets: 1,
}

const deletePolicy: AgentToolPolicy = {
  name: 'assets.delete',
  access: 'mutation',
  riskClass: 'destructive',
  reversibility: 'irreversible',
  requiredRole: 'owner',
  maximumTargets: 10,
}

function call(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: 'step_1',
    tool: 'assets.get',
    arguments: { assetId: target.assetId },
    expectedEffect: 'Read one asset.',
    targetIds: [target.assetId],
    ...overrides,
  }
}

describe('agent plan identity', () => {
  it('hashes semantically identical object key order to the same value', () => {
    const left = { calls: [{ tool: 'assets.get', arguments: { z: 1, a: true } }], version: 1 }
    const right = { version: 1, calls: [{ arguments: { a: true, z: 1 }, tool: 'assets.get' }] }
    assert.equal(canonicalPlanJson(left), canonicalPlanJson(right))
    assert.equal(hashAgentPlan(left), hashAgentPlan(right))
    assert.match(hashAgentPlan(left), /^[0-9a-f]{64}$/)
  })

  it('rejects values that JSON cannot safely preserve', () => {
    assert.throws(() => hashAgentPlan({ cost: Number.NaN }), /non-finite/)
    assert.throws(() => hashAgentPlan({ value: 1n }), /cannot be represented/)
  })
})

describe('agent policy gateway', () => {
  it('allows registered read tools without requiring approval', () => {
    assert.deepEqual(
      evaluateAgentPlan(
        {
          calls: [call()],
          targets: [target],
          budget,
          estimatedCostMicroUsd: 0,
          estimatedOutputBytes: 0,
        },
        [readPolicy],
      ),
      {
        riskClass: 'standard',
        reversibility: 'reversible',
        requiredRole: 'admin',
        requiresApproval: false,
      },
    )
  })

  it('escalates mixed plans to their strongest policy and requires mutation approval', () => {
    const decision = evaluateAgentPlan(
      {
        calls: [call(), call({ id: 'step_2', tool: 'assets.delete' })],
        targets: [target],
        budget,
        estimatedCostMicroUsd: 0,
        estimatedOutputBytes: 0,
      },
      [readPolicy, deletePolicy],
    )
    assert.deepEqual(decision, {
      riskClass: 'destructive',
      reversibility: 'irreversible',
      requiredRole: 'owner',
      requiresApproval: true,
    })
  })

  it('fails closed for unknown tools, missing snapshots, and exceeded budgets', () => {
    const proposal = {
      calls: [call()],
      targets: [target],
      budget,
      estimatedCostMicroUsd: 0,
      estimatedOutputBytes: 0,
    }
    assert.throws(
      () => evaluateAgentPlan({ ...proposal, calls: [call({ tool: 'shell.run' })] }, [readPolicy]),
      (error: unknown) => error instanceof AgentPolicyError && error.code === 'unknown_tool',
    )
    assert.throws(
      () => evaluateAgentPlan({ ...proposal, targets: [] }, [readPolicy]),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === 'missing_target_snapshot',
    )
    assert.throws(
      () => evaluateAgentPlan({ ...proposal, estimatedCostMicroUsd: 20_001 }, [readPolicy]),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === 'cost_budget_exceeded',
    )
  })
})
