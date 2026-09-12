import { and, eq } from 'drizzle-orm'
import type { DatabaseConnection } from '../db/database.js'
import { jobs } from '../db/schema.js'
import type { JobRecord, JobRepository, TenantScope } from '../repositories/types.js'

const baseRetryDelayMs = 1_000
const maximumRetryDelayMs = 5 * 60_000

export class JobLeaseLostError extends Error {
  override readonly name = 'JobLeaseLostError'
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workerId)) {
    throw new TypeError('Worker identifiers must contain 1 to 128 safe ASCII characters.')
  }
}

function assertLease(now: Date, leaseUntil: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(leaseUntil.getTime()) ||
    leaseUntil <= now
  ) {
    throw new TypeError('A job lease must expire after the current time.')
  }
}

function assertFailure(failure: { code: string; message: string; retryable?: boolean }): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(failure.code)) {
    throw new TypeError('Job failure codes must be stable lowercase identifiers.')
  }
  if (failure.message.trim() === '' || failure.message.length > 1_024) {
    throw new TypeError('Job failure messages must contain 1 to 1024 characters.')
  }
}

export function retryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError('Job attempts must be positive safe integers.')
  }
  return Math.min(maximumRetryDelayMs, baseRetryDelayMs * 2 ** Math.min(attempt - 1, 30))
}

function leaseLost(jobId: string): JobLeaseLostError {
  return new JobLeaseLostError(`The lease for job ${jobId} is no longer owned by this worker.`)
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly database: DatabaseConnection) {}

  findById(scope: TenantScope, jobId: string): JobRecord | null {
    return (
      this.database.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.organizationId, scope.organizationId),
            eq(jobs.projectId, scope.projectId),
          ),
        )
        .get() ?? null
    )
  }

  claimNext(workerId: string, now: Date, leaseUntil: Date): JobRecord | null {
    assertWorkerId(workerId)
    assertLease(now, leaseUntil)
    const claim = this.database.client.transaction(() => {
      this.database.client
        .prepare(
          `update jobs
             set state = 'failed',
                 error_code = 'attempts_exhausted',
                 error_message = 'The worker lease expired after the final permitted attempt.',
                 lease_owner = null,
                 lease_expires_at = null,
                 completed_at = ?,
                 updated_at = ?
           where attempts >= max_attempts
             and (state = 'queued' or (state = 'running' and lease_expires_at <= ?))`,
        )
        .run(now.getTime(), now.getTime(), now.getTime())

      const candidate = this.database.client
        .prepare(
          `select id
             from jobs
            where attempts < max_attempts
              and ((state = 'queued' and run_after <= ?)
                or (state = 'running' and lease_expires_at <= ?))
            order by run_after asc, created_at asc, id asc
            limit 1`,
        )
        .get(now.getTime(), now.getTime()) as { id: string } | undefined
      if (!candidate) return null

      this.database.client
        .prepare(
          `update jobs
              set state = 'running',
                  attempts = attempts + 1,
                  progress = 0,
                  lease_owner = ?,
                  lease_expires_at = ?,
                  error_code = null,
                  error_message = null,
                  completed_at = null,
                  updated_at = ?
            where id = ?`,
        )
        .run(workerId, leaseUntil.getTime(), now.getTime(), candidate.id)
      return this.database.db.select().from(jobs).where(eq(jobs.id, candidate.id)).get() ?? null
    })
    return claim.immediate()
  }

  heartbeat(jobId: string, workerId: string, now: Date, leaseUntil: Date): JobRecord {
    assertWorkerId(workerId)
    assertLease(now, leaseUntil)
    return this.updateLeased(jobId, workerId, now, `lease_expires_at = ?, updated_at = ?`, [
      leaseUntil.getTime(),
      now.getTime(),
    ])
  }

  updateProgress(jobId: string, workerId: string, now: Date, progress: number): JobRecord {
    assertWorkerId(workerId)
    if (!Number.isSafeInteger(progress) || progress < 0 || progress > 99) {
      throw new TypeError('Running job progress must be an integer from 0 to 99.')
    }
    return this.updateLeased(jobId, workerId, now, `progress = ?, updated_at = ?`, [
      progress,
      now.getTime(),
    ])
  }

  succeed(jobId: string, workerId: string, now: Date): JobRecord {
    assertWorkerId(workerId)
    return this.updateLeased(
      jobId,
      workerId,
      now,
      `state = 'succeeded', progress = 100, lease_owner = null, lease_expires_at = null,
       error_code = null, error_message = null, completed_at = ?, updated_at = ?`,
      [now.getTime(), now.getTime()],
    )
  }

  fail(
    jobId: string,
    workerId: string,
    now: Date,
    failure: { code: string; message: string; retryable?: boolean },
  ): JobRecord {
    assertWorkerId(workerId)
    assertFailure(failure)
    const transaction = this.database.client.transaction(() => {
      const current = this.requireLease(jobId, workerId, now)
      const exhausted = failure.retryable === false || current.attempts >= current.maxAttempts
      const runAfter = new Date(now.getTime() + retryDelayMs(current.attempts))
      this.database.client
        .prepare(
          `update jobs
              set state = ?, run_after = ?, lease_owner = null, lease_expires_at = null,
                  error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
            where id = ?`,
        )
        .run(
          exhausted ? 'failed' : 'queued',
          exhausted ? current.runAfter.getTime() : runAfter.getTime(),
          failure.code,
          failure.message,
          exhausted ? now.getTime() : null,
          now.getTime(),
          jobId,
        )
      return this.database.db.select().from(jobs).where(eq(jobs.id, jobId)).get() as JobRecord
    })
    return transaction.immediate()
  }

  private updateLeased(
    jobId: string,
    workerId: string,
    now: Date,
    assignment: string,
    parameters: readonly unknown[],
  ): JobRecord {
    const result = this.database.client
      .prepare(
        `update jobs set ${assignment}
          where id = ? and state = 'running' and lease_owner = ? and lease_expires_at > ?`,
      )
      .run(...parameters, jobId, workerId, now.getTime())
    if (result.changes !== 1) throw leaseLost(jobId)
    return this.database.db.select().from(jobs).where(eq(jobs.id, jobId)).get() as JobRecord
  }

  private requireLease(jobId: string, workerId: string, now: Date): JobRecord {
    const job = this.database.db.select().from(jobs).where(eq(jobs.id, jobId)).get()
    if (
      job?.state !== 'running' ||
      job.leaseOwner !== workerId ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= now
    ) {
      throw leaseLost(jobId)
    }
    return job
  }
}
