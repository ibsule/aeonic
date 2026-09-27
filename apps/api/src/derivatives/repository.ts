import { and, eq } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { derivatives } from '../db/schema.js'
import type { TenantScope } from '../repositories/types.js'

export type DerivativeRecord = typeof derivatives.$inferSelect
export type DerivativeKind = DerivativeRecord['kind']
export type DerivativeOutputFormat = DerivativeRecord['outputFormat']

export interface AcquireDerivativeInput extends TenantScope {
  readonly assetVersionId: string
  readonly kind?: DerivativeKind
  readonly cacheKey: string
  readonly canonicalSpec: string
  readonly outputFormat: DerivativeOutputFormat
  readonly processorFingerprint: string
  readonly createdBy?: string
}

export interface DerivativeLeaseResult {
  readonly derivative: DerivativeRecord
  readonly acquired: boolean
}

export interface CompletedDerivative {
  readonly storageObjectId: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly mimeType: string
  readonly width?: number
  readonly height?: number
  readonly durationMs?: number
}

export class DerivativeLeaseLostError extends Error {
  override readonly name = 'DerivativeLeaseLostError'
}

export class DerivativeIdentityCollisionError extends Error {
  override readonly name = 'DerivativeIdentityCollisionError'
}

function assertOwner(owner: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(owner)) {
    throw new TypeError('Derivative lease owners must contain 1 to 128 safe ASCII characters.')
  }
}

function assertLease(now: Date, leaseUntil: Date): void {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(leaseUntil.getTime()) ||
    leaseUntil <= now
  ) {
    throw new TypeError('A derivative lease must expire after the current time.')
  }
}

function leaseLost(id: string): DerivativeLeaseLostError {
  return new DerivativeLeaseLostError(`The derivative lease for ${id} is no longer owned.`)
}

function sameIdentity(record: DerivativeRecord, input: AcquireDerivativeInput): boolean {
  return (
    record.organizationId === input.organizationId &&
    record.projectId === input.projectId &&
    record.assetVersionId === input.assetVersionId &&
    record.kind === (input.kind ?? 'image') &&
    record.cacheKey === input.cacheKey &&
    record.canonicalSpec === input.canonicalSpec &&
    record.outputFormat === input.outputFormat &&
    record.processorFingerprint === input.processorFingerprint
  )
}

const outputMimeTypes: Record<DerivativeOutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
}

export class SqliteDerivativeRepository {
  constructor(private readonly database: DatabaseConnection) {}

  find(scope: TenantScope, cacheKey: string): DerivativeRecord | null {
    return (
      this.database.db
        .select()
        .from(derivatives)
        .where(
          and(
            eq(derivatives.organizationId, scope.organizationId),
            eq(derivatives.projectId, scope.projectId),
            eq(derivatives.cacheKey, cacheKey),
          ),
        )
        .get() ?? null
    )
  }

  acquire(
    input: AcquireDerivativeInput,
    owner: string,
    now: Date,
    leaseUntil: Date,
  ): DerivativeLeaseResult {
    assertOwner(owner)
    assertLease(now, leaseUntil)
    if (!isUuid(input.assetVersionId) || !/^[0-9a-f]{64}$/.test(input.cacheKey)) {
      throw new TypeError('Derivative acquisition requires a valid version ID and cache key.')
    }

    return this.database.client
      .transaction(() => {
        const current = this.find(input, input.cacheKey)
        if (!current) {
          const id = uuidv7()
          this.database.db
            .insert(derivatives)
            .values({
              id,
              organizationId: input.organizationId,
              projectId: input.projectId,
              assetVersionId: input.assetVersionId,
              cacheKey: input.cacheKey,
              kind: input.kind ?? 'image',
              grammarVersion: 1,
              canonicalSpec: input.canonicalSpec,
              outputFormat: input.outputFormat,
              processorFingerprint: input.processorFingerprint,
              state: 'generating',
              attempts: 1,
              leaseOwner: owner,
              leaseExpiresAt: leaseUntil,
              ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
              createdAt: now,
              updatedAt: now,
            })
            .run()
          return {
            derivative: this.database.db
              .select()
              .from(derivatives)
              .where(eq(derivatives.id, id))
              .get() as DerivativeRecord,
            acquired: true,
          }
        }
        if (!sameIdentity(current, input)) {
          throw new DerivativeIdentityCollisionError(
            'A cache key resolved to different derivative inputs.',
          )
        }
        if (
          current.state !== 'queued' &&
          current.state !== 'failed' &&
          !(
            current.state === 'generating' &&
            current.leaseExpiresAt &&
            current.leaseExpiresAt <= now
          )
        ) {
          return { derivative: current, acquired: false }
        }
        this.database.client
          .prepare(
            `update derivatives set state = 'generating', attempts = attempts + 1,
               lease_owner = ?, lease_expires_at = ?, error_code = null, updated_at = ? where id = ?`,
          )
          .run(owner, leaseUntil.getTime(), now.getTime(), current.id)
        return {
          derivative: this.database.db
            .select()
            .from(derivatives)
            .where(eq(derivatives.id, current.id))
            .get() as DerivativeRecord,
          acquired: true,
        }
      })
      .immediate()
  }

  heartbeat(id: string, owner: string, now: Date, leaseUntil: Date): DerivativeRecord {
    assertOwner(owner)
    assertLease(now, leaseUntil)
    return this.updateLeased(id, owner, now, 'lease_expires_at = ?, updated_at = ?', [
      leaseUntil.getTime(),
      now.getTime(),
    ])
  }

  complete(id: string, owner: string, now: Date, output: CompletedDerivative): DerivativeRecord {
    assertOwner(owner)
    if (
      !isUuid(output.storageObjectId) ||
      !Number.isSafeInteger(output.sizeBytes) ||
      output.sizeBytes < 0 ||
      !/^[0-9a-f]{64}$/.test(output.sha256) ||
      (output.width !== undefined && (!Number.isSafeInteger(output.width) || output.width < 1)) ||
      (output.height !== undefined &&
        (!Number.isSafeInteger(output.height) || output.height < 1)) ||
      (output.width === undefined) !== (output.height === undefined) ||
      (output.durationMs !== undefined &&
        (!Number.isSafeInteger(output.durationMs) || output.durationMs < 0))
    ) {
      throw new TypeError('Completed derivative metadata is invalid.')
    }
    return this.database.client
      .transaction(() => {
        const current = this.requireLease(id, owner, now)
        if (output.mimeType !== outputMimeTypes[current.outputFormat]) {
          throw new TypeError('Completed derivative MIME type conflicts with its output format.')
        }
        this.database.client
          .prepare(
            `update derivatives
                set state = 'ready', storage_object_id = ?, size_bytes = ?, sha256 = ?,
                    mime_type = ?, width = ?, height = ?, duration_ms = ?, lease_owner = null,
                    lease_expires_at = null, error_code = null, completed_at = ?, updated_at = ?
              where id = ?`,
          )
          .run(
            output.storageObjectId,
            output.sizeBytes,
            output.sha256,
            output.mimeType,
            output.width ?? null,
            output.height ?? null,
            output.durationMs ?? null,
            now.getTime(),
            now.getTime(),
            id,
          )
        return this.database.db
          .select()
          .from(derivatives)
          .where(eq(derivatives.id, id))
          .get() as DerivativeRecord
      })
      .immediate()
  }

  fail(id: string, owner: string, now: Date, errorCode: string): DerivativeRecord {
    assertOwner(owner)
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(errorCode)) {
      throw new TypeError('Derivative failure codes must be stable lowercase identifiers.')
    }
    return this.updateLeased(
      id,
      owner,
      now,
      `state = 'failed', lease_owner = null, lease_expires_at = null,
       error_code = ?, completed_at = ?, updated_at = ?`,
      [errorCode, now.getTime(), now.getTime()],
    )
  }

  private updateLeased(
    id: string,
    owner: string,
    now: Date,
    assignment: string,
    parameters: readonly unknown[],
  ): DerivativeRecord {
    const changed = this.database.client
      .prepare(
        `update derivatives set ${assignment}
          where id = ? and state = 'generating' and lease_owner = ? and lease_expires_at > ?`,
      )
      .run(...parameters, id, owner, now.getTime())
    if (changed.changes !== 1) throw leaseLost(id)
    return this.database.db
      .select()
      .from(derivatives)
      .where(eq(derivatives.id, id))
      .get() as DerivativeRecord
  }

  private requireLease(id: string, owner: string, now: Date): DerivativeRecord {
    const derivative = this.database.db
      .select()
      .from(derivatives)
      .where(eq(derivatives.id, id))
      .get()
    if (
      derivative?.state !== 'generating' ||
      derivative.leaseOwner !== owner ||
      !derivative.leaseExpiresAt ||
      derivative.leaseExpiresAt <= now
    ) {
      throw leaseLost(id)
    }
    return derivative
  }
}
