import type { Job, JobList, JobState } from '@aeonic/contracts'
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import { validate as isUuid } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { jobs } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../http/authentication.js'
import type { ProjectService } from '../projects/service.js'
import type { TenantScope } from '../repositories/types.js'

export interface ListJobsOptions {
  cursor?: string
  limit: number
  state?: JobState
}

const operatorMessages: Record<string, string> = {
  attempts_exhausted: 'Processing did not complete after the configured retry limit.',
  command_failed:
    'The media processor could not complete this operation. Check the source format and worker tools.',
  invalid_media: 'The uploaded file could not be validated as supported media.',
  storage_error:
    'The worker could not read or write storage. Check storage health and permissions.',
}

function toJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    errorCode: row.errorCode,
    errorMessage: row.errorCode
      ? (operatorMessages[row.errorCode] ??
        'Processing failed. Use this job ID when reviewing worker logs.')
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

export class JobService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
  ) {}

  list(principal: Principal, scope: TenantScope, options: ListJobsOptions): JobList {
    this.authorize(principal, scope)
    const conditions: SQL[] = [
      eq(jobs.organizationId, scope.organizationId),
      eq(jobs.projectId, scope.projectId),
    ]
    if (options.state) conditions.push(eq(jobs.state, options.state))
    if (options.cursor) {
      if (!isUuid(options.cursor))
        throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
      const cursor = this.database.db
        .select({ id: jobs.id, createdAt: jobs.createdAt })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, options.cursor),
            eq(jobs.organizationId, scope.organizationId),
            eq(jobs.projectId, scope.projectId),
          ),
        )
        .get()
      if (!cursor)
        throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
      conditions.push(
        or(
          lt(jobs.createdAt, cursor.createdAt),
          and(eq(jobs.createdAt, cursor.createdAt), lt(jobs.id, cursor.id)),
        ) as SQL,
      )
    }
    const rows = this.database.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(options.limit + 1)
      .all()
    const hasMore = rows.length > options.limit
    const items = rows.slice(0, options.limit).map(toJob)
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null }
  }

  get(principal: Principal, scope: TenantScope, jobId: string): Job {
    this.authorize(principal, scope)
    if (!isUuid(jobId))
      throw new ApiError(404, 'Job not found', 'job_not_found', 'The job does not exist.')
    const row = this.database.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.organizationId, scope.organizationId),
          eq(jobs.projectId, scope.projectId),
        ),
      )
      .get()
    if (!row) throw new ApiError(404, 'Job not found', 'job_not_found', 'The job does not exist.')
    return toJob(row)
  }

  private authorize(principal: Principal, scope: TenantScope): void {
    if (principal.type === 'user') {
      this.projects.authorize(principal.userId, scope.organizationId, scope.projectId, 'read')
      return
    }
    if (
      principal.organizationId !== scope.organizationId ||
      principal.projectId !== scope.projectId
    ) {
      throw new ApiError(403, 'Access denied', 'access_denied', 'You cannot perform this action.')
    }
  }
}
