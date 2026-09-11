import type { ProjectStorageOverview, StorageFailureSummary } from '@aeonic/contracts'
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { DatabaseConnection } from '../db/database.js'
import { projectApiKeys, storageObjects, uploads } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'
import type { StorageRuntime } from './factory.js'

interface Counts {
  available: number
  staging: number
  failed: number
}

interface UploadCounts {
  active: number
  failed: number
  rejected: number
  expired: number
}

function number(value: number | null | undefined): number {
  return value ?? 0
}

export class StorageService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
    private readonly storage: StorageRuntime,
    private readonly quotaBytes: number,
  ) {}

  #authorize(principal: Principal, scope: TenantScope): void {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, 'read')
      return
    }
    const active = this.database.db
      .select({ id: projectApiKeys.keyId })
      .from(projectApiKeys)
      .where(
        and(
          eq(projectApiKeys.keyId, principal.keyId),
          eq(projectApiKeys.organizationId, scope.organizationId),
          eq(projectApiKeys.projectId, scope.projectId),
          isNull(projectApiKeys.revokedAt),
        ),
      )
      .get()
    if (!active) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'The API key is no longer active.')
    }
  }

  async overview(principal: Principal, scope: TenantScope): Promise<ProjectStorageOverview> {
    this.#authorize(principal, scope)
    const objectSummary = this.database.db
      .select({
        usedBytes: sql<number>`coalesce(sum(case when ${storageObjects.state} = 'available' then ${storageObjects.sizeBytes} else 0 end), 0)`,
        available: sql<number>`sum(case when ${storageObjects.state} = 'available' then 1 else 0 end)`,
        staging: sql<number>`sum(case when ${storageObjects.state} = 'staging' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${storageObjects.state} = 'failed' then 1 else 0 end)`,
      })
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.organizationId, scope.organizationId),
          eq(storageObjects.projectId, scope.projectId),
        ),
      )
      .get()
    const uploadSummary = this.database.db
      .select({
        reservedBytes: sql<number>`coalesce(sum(case when ${uploads.state} in ('created', 'receiving', 'validating') then ${uploads.expectedBytes} else 0 end), 0)`,
        active: sql<number>`sum(case when ${uploads.state} in ('created', 'receiving', 'validating') then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${uploads.state} = 'failed' then 1 else 0 end)`,
        rejected: sql<number>`sum(case when ${uploads.state} = 'rejected' then 1 else 0 end)`,
        expired: sql<number>`sum(case when ${uploads.state} = 'expired' then 1 else 0 end)`,
      })
      .from(uploads)
      .where(
        and(
          eq(uploads.organizationId, scope.organizationId),
          eq(uploads.projectId, scope.projectId),
        ),
      )
      .get()
    const objectFailures = this.database.db
      .select({ code: storageObjects.errorCode, count: sql<number>`count(*)` })
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.organizationId, scope.organizationId),
          eq(storageObjects.projectId, scope.projectId),
          eq(storageObjects.state, 'failed'),
          isNotNull(storageObjects.errorCode),
        ),
      )
      .groupBy(storageObjects.errorCode)
      .all()
    const uploadFailures = this.database.db
      .select({ code: uploads.errorCode, count: sql<number>`count(*)` })
      .from(uploads)
      .where(
        and(
          eq(uploads.organizationId, scope.organizationId),
          eq(uploads.projectId, scope.projectId),
          inArray(uploads.state, ['failed', 'rejected', 'expired']),
          isNotNull(uploads.errorCode),
        ),
      )
      .groupBy(uploads.errorCode)
      .all()
    const usedBytes = number(objectSummary?.usedBytes)
    const reservedBytes = number(uploadSummary?.reservedBytes)
    const health = await this.storage.port.health()
    const failures: StorageFailureSummary[] = [
      ...objectFailures.flatMap(({ code, count }) =>
        code === null ? [] : [{ source: 'object' as const, code, count }],
      ),
      ...uploadFailures.flatMap(({ code, count }) =>
        code === null ? [] : [{ source: 'upload' as const, code, count }],
      ),
    ].sort((left, right) =>
      left.source === right.source
        ? left.code.localeCompare(right.code)
        : left.source.localeCompare(right.source),
    )

    return {
      backend: this.storage.backend,
      health: {
        status: health.status,
        writable: health.writable,
        capacity:
          health.capacity === null
            ? null
            : {
                totalBytes: String(health.capacity.totalBytes),
                availableBytes: String(health.capacity.availableBytes),
              },
      },
      usage: {
        usedBytes,
        reservedBytes,
        quotaBytes: this.quotaBytes,
        quotaRemainingBytes: Math.max(0, this.quotaBytes - usedBytes - reservedBytes),
      },
      objects: {
        available: number((objectSummary as Counts | undefined)?.available),
        staging: number((objectSummary as Counts | undefined)?.staging),
        failed: number((objectSummary as Counts | undefined)?.failed),
      },
      uploads: {
        active: number((uploadSummary as UploadCounts | undefined)?.active),
        failed: number((uploadSummary as UploadCounts | undefined)?.failed),
        rejected: number((uploadSummary as UploadCounts | undefined)?.rejected),
        expired: number((uploadSummary as UploadCounts | undefined)?.expired),
      },
      failures,
      checkedAt: new Date().toISOString(),
    }
  }
}
