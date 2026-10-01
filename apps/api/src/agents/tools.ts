import { and, desc, eq, type SQL } from 'drizzle-orm'
import { validate as isUuid } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { assets, assetVersions } from '../db/schema.js'
import type { TenantScope } from '../repositories/types.js'
import { AgentPolicyError, type AgentToolPolicy } from './policy.js'

export const agentReadToolPolicies = [
  {
    name: 'assets.get',
    access: 'read',
    riskClass: 'standard',
    reversibility: 'reversible',
    requiredRole: 'admin',
    maximumTargets: 1,
  },
  {
    name: 'assets.list',
    access: 'read',
    riskClass: 'standard',
    reversibility: 'reversible',
    requiredRole: 'admin',
    maximumTargets: 0,
  },
] as const satisfies readonly AgentToolPolicy[]

export interface AgentToolResult {
  readonly tool: string
  readonly data: unknown
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentPolicyError('invalid_tool_arguments', 'Tool arguments must be an object.')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) {
    throw new AgentPolicyError('invalid_tool_arguments', `Tool argument ${unknown} is not allowed.`)
  }
}

export class AgentReadToolService {
  constructor(private readonly database: DatabaseConnection) {}

  execute(scope: TenantScope, tool: string, rawArguments: unknown): AgentToolResult {
    if (tool === 'assets.get') return { tool, data: this.getAsset(scope, rawArguments) }
    if (tool === 'assets.list') return { tool, data: this.listAssets(scope, rawArguments) }
    throw new AgentPolicyError('unknown_tool', `Read tool ${tool} is not registered.`)
  }

  private getAsset(scope: TenantScope, rawArguments: unknown): unknown {
    const input = objectArguments(rawArguments)
    exactKeys(input, ['assetId'])
    if (typeof input.assetId !== 'string' || !isUuid(input.assetId)) {
      throw new AgentPolicyError('invalid_tool_arguments', 'assets.get requires one UUID assetId.')
    }
    const asset = this.database.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, input.assetId),
          eq(assets.organizationId, scope.organizationId),
          eq(assets.projectId, scope.projectId),
        ),
      )
      .get()
    if (!asset) return null
    const version =
      asset.currentVersion > 0
        ? (this.database.db
            .select()
            .from(assetVersions)
            .where(
              and(
                eq(assetVersions.assetId, asset.id),
                eq(assetVersions.organizationId, scope.organizationId),
                eq(assetVersions.projectId, scope.projectId),
                eq(assetVersions.version, asset.currentVersion),
              ),
            )
            .get() ?? null)
        : null
    return { asset, version }
  }

  private listAssets(scope: TenantScope, rawArguments: unknown): unknown {
    const input = objectArguments(rawArguments)
    exactKeys(input, ['limit', 'mediaKind', 'state'])
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
      throw new AgentPolicyError(
        'invalid_tool_arguments',
        'assets.list limit must be an integer from 1 to 100.',
      )
    }
    const filters: SQL[] = [
      eq(assets.organizationId, scope.organizationId),
      eq(assets.projectId, scope.projectId),
    ]
    if (input.mediaKind !== undefined) {
      if (!['image', 'video', 'document'].includes(String(input.mediaKind))) {
        throw new AgentPolicyError('invalid_tool_arguments', 'assets.list mediaKind is invalid.')
      }
      filters.push(eq(assets.mediaKind, input.mediaKind as 'image' | 'video' | 'document'))
    }
    if (input.state !== undefined) {
      if (
        ![
          'uploading',
          'validating',
          'processing',
          'ready',
          'replacing',
          'deleting',
          'deleted',
          'rejected',
          'failed',
        ].includes(String(input.state))
      ) {
        throw new AgentPolicyError('invalid_tool_arguments', 'assets.list state is invalid.')
      }
      filters.push(eq(assets.state, input.state as typeof assets.$inferSelect.state))
    }
    return this.database.db
      .select({
        id: assets.id,
        publicId: assets.publicId,
        name: assets.name,
        mediaKind: assets.mediaKind,
        visibility: assets.visibility,
        state: assets.state,
        currentVersion: assets.currentVersion,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .where(and(...filters))
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(limit as number)
      .all()
  }
}
