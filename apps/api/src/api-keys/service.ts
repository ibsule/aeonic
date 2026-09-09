import type {
  ApiKey,
  ApiKeyList,
  ApiKeyScope,
  CreateApiKeyRequest,
  CreatedApiKey,
} from '@aeonic/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AuthService } from '../auth/auth.js'
import { roleHasOrganizationWideProjectAccess } from '../authorization/policy.js'
import type { DatabaseConnection } from '../db/database.js'
import { apikey, auditEvents, projectApiKeys } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { ProjectService } from '../projects/service.js'

function permissionsFor(scopes: readonly ApiKeyScope[]): Record<string, string[]> {
  const permissions: Record<string, string[]> = {}
  const add = (resource: string, ...actions: string[]): void => {
    permissions[resource] = [...new Set([...(permissions[resource] ?? []), ...actions])]
  }

  for (const scope of scopes) {
    if (scope === 'projects:read') add('project', 'read')
    if (scope === 'assets:read') add('asset', 'read')
    if (scope === 'assets:write') add('asset', 'create', 'update')
    if (scope === 'assets:delete') add('asset', 'delete')
    if (scope === 'jobs:read') add('job', 'read')
  }
  return permissions
}

function scopesFrom(value: string | null): ApiKeyScope[] {
  if (!value) return []
  const permissions = JSON.parse(value) as Record<string, unknown>
  const has = (resource: string, action: string): boolean => {
    const actions = permissions[resource]
    return Array.isArray(actions) && actions.includes(action)
  }
  return [
    ...(has('project', 'read') ? (['projects:read'] as const) : []),
    ...(has('asset', 'read') ? (['assets:read'] as const) : []),
    ...(has('asset', 'create') || has('asset', 'update') ? (['assets:write'] as const) : []),
    ...(has('asset', 'delete') ? (['assets:delete'] as const) : []),
    ...(has('job', 'read') ? (['jobs:read'] as const) : []),
  ]
}

export class ApiKeyService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly auth: AuthService,
    private readonly projects: ProjectService,
  ) {}

  async create(
    userId: string,
    organizationId: string,
    projectId: string,
    input: CreateApiKeyRequest,
    requestId: string,
  ): Promise<CreatedApiKey> {
    this.projects.authorize(userId, organizationId, projectId, 'manage_api_keys')
    const created = await this.auth.createOrganizationApiKey({
      organizationId,
      userId,
      projectId,
      name: input.name.trim(),
      permissions: permissionsFor(input.scopes),
      ...(input.expiresInSeconds === undefined ? {} : { expiresIn: input.expiresInSeconds }),
    })

    try {
      this.database.db.transaction((transaction) => {
        transaction
          .insert(projectApiKeys)
          .values({
            keyId: created.id,
            organizationId,
            projectId,
            createdBy: userId,
            createdAt: created.createdAt,
          })
          .run()
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId,
            projectId,
            actorType: 'user',
            actorId: userId,
            action: 'api_key.created',
            targetType: 'api_key',
            targetId: created.id,
            requestId,
            summary: { name: input.name, scopes: input.scopes },
            createdAt: created.createdAt,
          })
          .run()
      })
    } catch (error) {
      this.database.db.delete(apikey).where(eq(apikey.id, created.id)).run()
      throw error
    }

    return {
      id: created.id,
      projectId,
      name: created.name ?? input.name,
      prefix: created.prefix ?? created.start,
      scopes: input.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
      revokedAt: null,
      secret: created.key,
    }
  }

  list(userId: string, organizationId: string, projectId: string): ApiKeyList {
    const role = this.projects.authorize(userId, organizationId, projectId, 'manage_api_keys')
    const rows = this.database.db
      .select({
        id: apikey.id,
        name: apikey.name,
        prefix: apikey.prefix,
        start: apikey.start,
        permissions: apikey.permissions,
        expiresAt: apikey.expiresAt,
        createdAt: apikey.createdAt,
        revokedAt: projectApiKeys.revokedAt,
        createdBy: projectApiKeys.createdBy,
      })
      .from(projectApiKeys)
      .innerJoin(apikey, eq(apikey.id, projectApiKeys.keyId))
      .where(
        and(
          eq(projectApiKeys.organizationId, organizationId),
          eq(projectApiKeys.projectId, projectId),
          ...(roleHasOrganizationWideProjectAccess(role)
            ? []
            : [eq(projectApiKeys.createdBy, userId)]),
        ),
      )
      .all()

    return {
      items: rows.map(
        (row): ApiKey => ({
          id: row.id,
          projectId,
          name: row.name ?? 'Unnamed key',
          prefix: row.prefix ?? row.start,
          scopes: scopesFrom(row.permissions),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
        }),
      ),
    }
  }

  revoke(
    userId: string,
    organizationId: string,
    projectId: string,
    keyId: string,
    requestId: string,
  ): void {
    const role = this.projects.authorize(userId, organizationId, projectId, 'manage_api_keys')
    const key = this.database.db
      .select({ createdBy: projectApiKeys.createdBy, revokedAt: projectApiKeys.revokedAt })
      .from(projectApiKeys)
      .where(
        and(
          eq(projectApiKeys.keyId, keyId),
          eq(projectApiKeys.organizationId, organizationId),
          eq(projectApiKeys.projectId, projectId),
        ),
      )
      .get()
    if (!key || (!roleHasOrganizationWideProjectAccess(role) && key.createdBy !== userId)) {
      throw new ApiError(
        404,
        'API key not found',
        'api_key_not_found',
        'The API key does not exist.',
      )
    }
    if (key.revokedAt) return

    const now = new Date()
    this.database.db.transaction((transaction) => {
      transaction
        .update(apikey)
        .set({ enabled: false, updatedAt: now })
        .where(eq(apikey.id, keyId))
        .run()
      transaction
        .update(projectApiKeys)
        .set({ revokedAt: now })
        .where(and(eq(projectApiKeys.keyId, keyId), isNull(projectApiKeys.revokedAt)))
        .run()
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId,
          projectId,
          actorType: 'user',
          actorId: userId,
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: keyId,
          requestId,
          createdAt: now,
        })
        .run()
    })
  }
}
