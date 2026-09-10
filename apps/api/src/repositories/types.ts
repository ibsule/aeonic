export interface TenantScope {
  organizationId: string
  projectId: string
}

export type AssetState =
  | 'uploading'
  | 'validating'
  | 'processing'
  | 'ready'
  | 'replacing'
  | 'deleting'
  | 'deleted'
  | 'rejected'
  | 'failed'
export type AssetVersionState =
  | 'uploading'
  | 'validating'
  | 'processing'
  | 'ready'
  | 'rejected'
  | 'failed'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type StorageObjectState = 'staging' | 'available' | 'deleting' | 'deleted' | 'failed'
export type UploadState =
  | 'created'
  | 'receiving'
  | 'validating'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'terminated'

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

export interface StorageObjectRecord extends TenantScope {
  id: string
  backend: 'local' | 's3'
  namespace: 'temporary' | 'original' | 'derivative'
  objectKey: string
  state: StorageObjectState
  sizeBytes: number | null
  sha256: string | null
}

export interface UploadRecord extends TenantScope {
  id: string
  assetId: string | null
  storageObjectId: string | null
  protocol: 'simple' | 'tus'
  state: UploadState
  expectedBytes: number | null
  receivedBytes: number
}

export interface AssetRepository {
  findById(scope: TenantScope, assetId: string): AssetRecord | null
  listVersions(scope: TenantScope, assetId: string): readonly AssetVersionRecord[]
}

export interface JobRepository {
  findById(scope: TenantScope, jobId: string): JobRecord | null
  claimNext(workerId: string, now: Date, leaseUntil: Date): JobRecord | null
}

export interface StorageObjectRepository {
  findById(scope: TenantScope, storageObjectId: string): StorageObjectRecord | null
}

export interface UploadRepository {
  findById(scope: TenantScope, uploadId: string): UploadRecord | null
  findByIdempotencyKey(scope: TenantScope, idempotencyKey: string): UploadRecord | null
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
