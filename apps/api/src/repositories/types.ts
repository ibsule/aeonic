export interface TenantScope {
  organizationId: string
  projectId: string
}

export type AssetState = 'pending' | 'ready' | 'failed' | 'deleted'
export type AssetVersionState = 'pending' | 'ready' | 'failed'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface AssetRecord extends TenantScope {
  id: string
  publicId: string
  state: AssetState
  currentVersion: number
}

export interface AssetVersionRecord extends TenantScope {
  id: string
  assetId: string
  version: number
  state: AssetVersionState
}

export interface JobRecord extends TenantScope {
  id: string
  type: string
  state: JobState
  attempts: number
  maxAttempts: number
}

export interface AssetRepository {
  findById(scope: TenantScope, assetId: string): AssetRecord | null
  listVersions(scope: TenantScope, assetId: string): readonly AssetVersionRecord[]
}

export interface JobRepository {
  findById(scope: TenantScope, jobId: string): JobRecord | null
  claimNext(workerId: string, now: Date, leaseUntil: Date): JobRecord | null
}

export interface AuditEventRecord {
  id: string
  organizationId: string | null
  projectId: string | null
  actorType: 'user' | 'api_key' | 'system'
  actorId: string | null
  action: string
  targetType: string
  targetId: string
  requestId: string
  summary: Record<string, unknown> | null
  createdAt: Date
}

export interface AuditEventPage {
  items: readonly AuditEventRecord[]
  nextCursor: string | null
}

export interface AuditRepository {
  listOrganizationEvents(
    organizationId: string,
    options: { projectId?: string; cursor?: string; limit: number },
  ): AuditEventPage
}
