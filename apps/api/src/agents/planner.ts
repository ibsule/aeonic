import { and, eq } from 'drizzle-orm'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import { evaluateAgentPlan, type AgentToolPolicy } from './policy.js'
import type { FrozenAgentPlan, SqliteAgentWorkflowRepository } from './repository.js'

export const agentMutationToolPolicies = [
  {
    name: 'assets.update_metadata',
    access: 'mutation',
    riskClass: 'standard',
    reversibility: 'compensatable',
    requiredRole: 'admin',
    maximumTargets: 1,
  },
] as const satisfies readonly AgentToolPolicy[]

export interface AssetMetadataUpdatePlanRequest {
  readonly assetId: string
  readonly name?: string
  readonly folder?: string
  readonly visibility?: 'private' | 'public'
  readonly reason: string
  readonly idempotencyKey: string
}

const defaultBudget = {
  maxSteps: 1,
  maxWallTimeMs: 30_000,
  maxTokens: 0,
  maxCostMicroUsd: 0,
  maxAssets: 1,
  maxOutputBytes: 0,
  maxRetries: 1,
} as const

function notFound(): ApiError {
  return new ApiError(404, 'Asset not found', 'asset_not_found', 'The target asset does not exist.')
}

export class AgentPlannerService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly repository: SqliteAgentWorkflowRepository,
    private readonly projects: ProjectService,
  ) {}

  requestAssetMetadataUpdate(
    actorId: string,
    scope: TenantScope,
    input: AssetMetadataUpdatePlanRequest,
    requestId: string,
    now = new Date(),
  ): FrozenAgentPlan {
    this.projects.authorize(actorId, scope.organizationId, scope.projectId, 'update')
    if (!input.name && input.folder === undefined && input.visibility === undefined) {
      throw new ApiError(
        400,
        'No changes requested',
        'empty_agent_change',
        'At least one metadata change is required.',
      )
    }
    const target = this.database.db
      .select({
        assetId: assets.id,
        assetName: assets.name,
        assetUpdatedAt: assets.updatedAt,
        currentVersion: assets.currentVersion,
        assetVersionId: assetVersions.id,
        assetVersion: assetVersions.version,
      })
      .from(assets)
      .innerJoin(
        assetVersions,
        and(
          eq(assetVersions.assetId, assets.id),
          eq(assetVersions.organizationId, assets.organizationId),
          eq(assetVersions.projectId, assets.projectId),
          eq(assetVersions.version, assets.currentVersion),
        ),
      )
      .where(
        and(
          eq(assets.id, input.assetId),
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
        ),
      )
      .get()
    if (!target) throw notFound()

    const request = input.reason.trim()
    if (request.length < 1 || request.length > 1_000) {
      throw new ApiError(
        400,
        'Invalid reason',
        'invalid_agent_reason',
        'The workflow reason must contain 1 to 1000 characters.',
      )
    }
    const run = this.repository.createRun({
      ...scope,
      request,
      idempotencyKey: input.idempotencyKey,
      budget: defaultBudget,
      createdBy: actorId,
      requestId,
      now,
    })
    if (run.state !== 'planning') {
      const plan = this.repository.findPlanByRun(scope, run.id)
      const approval = plan ? this.repository.findApprovalForPlan(scope, plan.id) : null
      if (!plan || !approval) {
        throw new Error('An idempotent agent run is missing its frozen approval plan.')
      }
      return { plan, approval }
    }

    const call = {
      id: 'metadata_update',
      tool: 'assets.update_metadata',
      arguments: {
        assetId: target.assetId,
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.folder === undefined ? {} : { folder: input.folder.trim() }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      },
      expectedEffect: `Update metadata for “${target.assetName}”.`,
      targetIds: [target.assetId],
    }
    const snapshot = {
      assetId: target.assetId,
      assetVersionId: target.assetVersionId,
      assetVersion: target.assetVersion,
      assetUpdatedAt: target.assetUpdatedAt.toISOString(),
    }
    const decision = evaluateAgentPlan(
      {
        calls: [call],
        targets: [snapshot],
        budget: defaultBudget,
        estimatedCostMicroUsd: 0,
        estimatedOutputBytes: 0,
      },
      agentMutationToolPolicies,
    )
    if (!decision.requiresApproval) throw new Error('Mutation policy did not require approval.')
    return this.repository.freezePlanAndRequestApproval({
      ...scope,
      runId: run.id,
      plannerVersion: 'deterministic-metadata-v1',
      summary: `Update metadata for “${target.assetName}”`,
      riskClass: decision.riskClass,
      reversibility: decision.reversibility,
      requiredRole: decision.requiredRole,
      calls: [call],
      targets: [snapshot],
      budget: defaultBudget,
      estimatedCostMicroUsd: 0,
      estimatedOutputBytes: 0,
      requestedBy: actorId,
      requestId,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    })
  }
}
