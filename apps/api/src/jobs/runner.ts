import type { JobRecord, JobRepository } from '../repositories/types.js'
import { JobLeaseLostError } from './repository.js'

export interface JobHandlerContext {
  readonly signal: AbortSignal
  reportProgress(progress: number): void
}

export type JobHandler = (job: JobRecord, context: JobHandlerContext) => Promise<void>

export type JobRunOutcome =
  | 'idle'
  | 'succeeded'
  | 'retrying'
  | 'failed'
  | 'lease_lost'
  | 'interrupted'

export interface JobRunnerOptions {
  readonly workerId: string
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly timeoutMs: number
  readonly pollMs: number
  readonly now?: () => Date
}

export class JobExecutionError extends Error {
  override readonly name = 'JobExecutionError'

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

class JobTimedOutError extends Error {
  override readonly name = 'JobTimedOutError'
}

function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer number of milliseconds.`)
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, milliseconds)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

export class JobRunner {
  readonly #now: () => Date

  constructor(
    private readonly repository: JobRepository,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly options: JobRunnerOptions,
  ) {
    assertDuration('leaseMs', options.leaseMs)
    assertDuration('heartbeatMs', options.heartbeatMs)
    assertDuration('timeoutMs', options.timeoutMs)
    assertDuration('pollMs', options.pollMs)
    if (options.heartbeatMs * 2 >= options.leaseMs) {
      throw new TypeError('The heartbeat interval must be less than half the lease duration.')
    }
    this.#now = options.now ?? (() => new Date())
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const outcome = await this.runOnce(signal)
      if (outcome === 'idle') await abortableDelay(this.options.pollMs, signal)
    }
  }

  async runOnce(shutdownSignal: AbortSignal): Promise<JobRunOutcome> {
    if (shutdownSignal.aborted) return 'interrupted'
    const claimedAt = this.#now()
    const job = this.repository.claimNext(
      this.options.workerId,
      claimedAt,
      new Date(claimedAt.getTime() + this.options.leaseMs),
    )
    if (!job) return 'idle'

    const handler = this.handlers.get(job.type)
    if (!handler) {
      return this.persistFailure(
        job,
        new JobExecutionError(
          'unsupported_job',
          'No handler is registered for this job type.',
          false,
        ),
      )
    }

    const execution = new AbortController()
    let leaseLost = false
    const interrupt = (): void => execution.abort(shutdownSignal.reason)
    shutdownSignal.addEventListener('abort', interrupt, { once: true })
    const timeout = setTimeout(
      () => execution.abort(new JobTimedOutError('The job exceeded its processing deadline.')),
      this.options.timeoutMs,
    )
    const heartbeat = setInterval(() => {
      const now = this.#now()
      try {
        this.repository.heartbeat(
          job.id,
          this.options.workerId,
          now,
          new Date(now.getTime() + this.options.leaseMs),
        )
      } catch (error) {
        if (error instanceof JobLeaseLostError) leaseLost = true
        execution.abort(
          error instanceof JobLeaseLostError
            ? error
            : new JobExecutionError(
                'heartbeat_failed',
                'The worker could not renew the job lease.',
                true,
                { cause: error },
              ),
        )
      }
    }, this.options.heartbeatMs)

    try {
      await handler(job, {
        signal: execution.signal,
        reportProgress: (progress) => {
          this.repository.updateProgress(job.id, this.options.workerId, this.#now(), progress)
        },
      })
      if (leaseLost) return 'lease_lost'
      if (shutdownSignal.aborted) return 'interrupted'
      if (execution.signal.reason instanceof JobTimedOutError) {
        return this.persistFailure(
          job,
          new JobExecutionError('processing_timeout', 'The job exceeded its processing deadline.'),
        )
      }
      if (execution.signal.reason instanceof JobExecutionError) {
        return this.persistFailure(job, execution.signal.reason)
      }
      this.repository.succeed(job.id, this.options.workerId, this.#now())
      return 'succeeded'
    } catch (error) {
      if (leaseLost || error instanceof JobLeaseLostError) return 'lease_lost'
      if (shutdownSignal.aborted) return 'interrupted'
      if (execution.signal.reason instanceof JobTimedOutError) {
        return this.persistFailure(
          job,
          new JobExecutionError('processing_timeout', 'The job exceeded its processing deadline.'),
        )
      }
      return this.persistFailure(
        job,
        error instanceof JobExecutionError
          ? error
          : new JobExecutionError(
              'processing_failed',
              'The job handler failed unexpectedly.',
              true,
              { cause: error },
            ),
      )
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      shutdownSignal.removeEventListener('abort', interrupt)
    }
  }

  private persistFailure(job: JobRecord, error: JobExecutionError): JobRunOutcome {
    try {
      const result = this.repository.fail(job.id, this.options.workerId, this.#now(), {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      })
      return result.state === 'failed' ? 'failed' : 'retrying'
    } catch (failure) {
      if (failure instanceof JobLeaseLostError) return 'lease_lost'
      throw failure
    }
  }
}
