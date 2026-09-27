import type { ImageTransformPlanV1 } from '@aeonic/contracts'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import * as authSchema from './auth-schema.js'

export * from './auth-schema.js'

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
})

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    version: integer('version').notNull().default(1),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('projects_organization_slug_unique').on(table.organizationId, table.slug),
    uniqueIndex('projects_id_organization_unique').on(table.id, table.organizationId),
    index('projects_organization_id_idx').on(table.organizationId),
  ],
)

export const projectMembers = sqliteTable(
  'project_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'project_members_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('project_members_project_user_unique').on(table.projectId, table.userId),
    index('project_members_user_organization_idx').on(table.userId, table.organizationId),
  ],
)

export const projectApiKeys = sqliteTable(
  'project_api_keys',
  {
    keyId: text('key_id')
      .primaryKey()
      .references(() => authSchema.apikey.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'project_api_keys_project_organization_fk',
    }).onDelete('cascade'),
    index('project_api_keys_project_idx').on(table.organizationId, table.projectId),
    index('project_api_keys_created_by_idx').on(table.createdBy),
  ],
)

export const storageObjects = sqliteTable(
  'storage_objects',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    backend: text('backend', { enum: ['local', 's3'] }).notNull(),
    namespace: text('namespace', { enum: ['temporary', 'original', 'derivative'] }).notNull(),
    objectKey: text('object_key').notNull(),
    state: text('state', { enum: ['staging', 'available', 'deleting', 'deleted', 'failed'] })
      .notNull()
      .default('staging'),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    finalizedAt: integer('finalized_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    errorCode: text('error_code'),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'storage_objects_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('storage_objects_key_unique').on(table.objectKey),
    uniqueIndex('storage_objects_id_tenant_unique').on(
      table.id,
      table.organizationId,
      table.projectId,
    ),
    index('storage_objects_project_state_idx').on(
      table.organizationId,
      table.projectId,
      table.state,
    ),
    check(
      'storage_objects_size_nonnegative',
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    check(
      'storage_objects_state_valid',
      sql`${table.state} IN ('staging', 'available', 'deleting', 'deleted', 'failed')`,
    ),
    check(
      'storage_objects_sha256_valid',
      sql`${table.sha256} IS NULL OR (length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'storage_objects_available_metadata',
      sql`${table.state} <> 'available' OR (${table.sizeBytes} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.finalizedAt} IS NOT NULL)`,
    ),
  ],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    publicId: text('public_id').notNull(),
    name: text('name').notNull(),
    folder: text('folder').notNull().default(''),
    mediaKind: text('media_kind', { enum: ['image', 'video', 'document'] }).notNull(),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('private'),
    state: text('state', {
      enum: [
        'uploading',
        'validating',
        'processing',
        'ready',
        'replacing',
        'deleting',
        'deleted',
        'rejected',
        'failed',
      ],
    })
      .notNull()
      .default('uploading'),
    currentVersion: integer('current_version').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'assets_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('assets_project_public_id_unique').on(table.projectId, table.publicId),
    uniqueIndex('assets_id_organization_project_unique').on(
      table.id,
      table.organizationId,
      table.projectId,
    ),
    index('assets_project_created_idx').on(table.organizationId, table.projectId, table.createdAt),
    check('assets_current_version_nonnegative', sql`${table.currentVersion} >= 0`),
    check(
      'assets_state_valid',
      sql`${table.state} IN ('uploading', 'validating', 'processing', 'ready', 'replacing', 'deleting', 'deleted', 'rejected', 'failed')`,
    ),
  ],
)

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    assetId: text('asset_id').notNull(),
    version: integer('version').notNull(),
    state: text('state', {
      enum: ['uploading', 'validating', 'processing', 'ready', 'rejected', 'failed'],
    })
      .notNull()
      .default('uploading'),
    storageObjectId: text('storage_object_id'),
    sha256: text('sha256'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.organizationId, table.projectId],
      foreignColumns: [assets.id, assets.organizationId, assets.projectId],
      name: 'asset_versions_asset_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.storageObjectId, table.organizationId, table.projectId],
      foreignColumns: [storageObjects.id, storageObjects.organizationId, storageObjects.projectId],
      name: 'asset_versions_storage_object_tenant_fk',
    }).onDelete('restrict'),
    uniqueIndex('asset_versions_asset_version_unique').on(table.assetId, table.version),
    uniqueIndex('asset_versions_id_tenant_unique').on(
      table.id,
      table.organizationId,
      table.projectId,
    ),
    index('asset_versions_project_created_idx').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
    check('asset_versions_version_positive', sql`${table.version} > 0`),
    check(
      'asset_versions_size_nonnegative',
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    check(
      'asset_versions_state_valid',
      sql`${table.state} IN ('uploading', 'validating', 'processing', 'ready', 'rejected', 'failed')`,
    ),
    check(
      'asset_versions_sha256_valid',
      sql`${table.sha256} IS NULL OR (length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
)

export const derivatives = sqliteTable(
  'derivatives',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    assetVersionId: text('asset_version_id').notNull(),
    storageObjectId: text('storage_object_id'),
    cacheKey: text('cache_key').notNull(),
    kind: text('kind', {
      enum: [
        'image',
        'video_poster',
        'video_transcode',
        'pdf_thumbnail',
        'pdf_text',
        'office_preview',
      ],
    })
      .notNull()
      .default('image'),
    grammarVersion: integer('grammar_version').notNull(),
    canonicalSpec: text('canonical_spec').notNull(),
    outputFormat: text('output_format', {
      enum: ['jpeg', 'png', 'webp', 'avif', 'mp4', 'webm', 'pdf', 'txt'],
    }).notNull(),
    processorFingerprint: text('processor_fingerprint').notNull(),
    state: text('state', { enum: ['queued', 'generating', 'ready', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    mimeType: text('mime_type'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    createdBy: text('created_by').references(() => authSchema.user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'derivatives_project_organization_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.assetVersionId, table.organizationId, table.projectId],
      foreignColumns: [assetVersions.id, assetVersions.organizationId, assetVersions.projectId],
      name: 'derivatives_asset_version_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.storageObjectId, table.organizationId, table.projectId],
      foreignColumns: [storageObjects.id, storageObjects.organizationId, storageObjects.projectId],
      name: 'derivatives_storage_object_tenant_fk',
    }).onDelete('restrict'),
    uniqueIndex('derivatives_project_cache_key_unique').on(table.projectId, table.cacheKey),
    uniqueIndex('derivatives_id_tenant_unique').on(table.id, table.organizationId, table.projectId),
    index('derivatives_asset_version_idx').on(
      table.organizationId,
      table.projectId,
      table.assetVersionId,
    ),
    index('derivatives_generation_lease_idx').on(table.state, table.leaseExpiresAt),
    check(
      'derivatives_cache_key_valid',
      sql`length(${table.cacheKey}) = 64 AND ${table.cacheKey} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check('derivatives_grammar_v1', sql`${table.grammarVersion} = 1`),
    check(
      'derivatives_spec_valid',
      sql`length(${table.canonicalSpec}) BETWEEN 1 AND 256 AND ${table.canonicalSpec} NOT GLOB '*[^a-z0-9_.,-]*'`,
    ),
    check(
      'derivatives_kind_valid',
      sql`${table.kind} IN ('image', 'video_poster', 'video_transcode', 'pdf_thumbnail', 'pdf_text', 'office_preview')`,
    ),
    check(
      'derivatives_output_format_valid',
      sql`${table.outputFormat} IN ('jpeg', 'png', 'webp', 'avif', 'mp4', 'webm', 'pdf', 'txt')`,
    ),
    check(
      'derivatives_state_valid',
      sql`${table.state} IN ('queued', 'generating', 'ready', 'failed')`,
    ),
    check('derivatives_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check(
      'derivatives_lease_consistent',
      sql`(${table.state} = 'generating') = (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      'derivatives_size_nonnegative',
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    check(
      'derivatives_sha256_valid',
      sql`${table.sha256} IS NULL OR (length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'derivatives_dimensions_positive',
      sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`,
    ),
    check(
      'derivatives_duration_nonnegative',
      sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    check(
      'derivatives_ready_metadata',
      sql`${table.state} <> 'ready' OR (${table.storageObjectId} IS NOT NULL AND ${table.sizeBytes} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.mimeType} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'derivatives_terminal_unleased',
      sql`${table.state} NOT IN ('ready', 'failed') OR (${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
)

export const transformPresets = sqliteTable(
  'transform_presets',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    grammarVersion: integer('grammar_version').notNull(),
    canonicalSpec: text('canonical_spec').notNull(),
    definition: text('definition', { mode: 'json' }).$type<ImageTransformPlanV1>().notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'transform_presets_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('transform_presets_project_name_version_unique').on(
      table.projectId,
      table.name,
      table.version,
    ),
    uniqueIndex('transform_presets_id_tenant_unique').on(
      table.id,
      table.organizationId,
      table.projectId,
    ),
    index('transform_presets_project_name_idx').on(
      table.organizationId,
      table.projectId,
      table.name,
      table.version,
    ),
    check('transform_presets_version_positive', sql`${table.version} > 0`),
    check('transform_presets_grammar_v1', sql`${table.grammarVersion} = 1`),
    check(
      'transform_presets_name_valid',
      sql`length(${table.name}) BETWEEN 1 AND 64 AND ${table.name} NOT GLOB '*[^a-z0-9-]*' AND substr(${table.name}, 1, 1) GLOB '[a-z]' AND substr(${table.name}, -1, 1) GLOB '[a-z0-9]' AND ${table.name} NOT GLOB '*--*'`,
    ),
    check(
      'transform_presets_spec_valid',
      sql`length(${table.canonicalSpec}) BETWEEN 1 AND 256 AND ${table.canonicalSpec} NOT GLOB '*[^a-z0-9_.,]*'`,
    ),
  ],
)

export const uploads = sqliteTable(
  'uploads',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    assetId: text('asset_id'),
    storageObjectId: text('storage_object_id'),
    protocol: text('protocol', { enum: ['simple', 'tus'] }).notNull(),
    state: text('state', {
      enum: [
        'created',
        'receiving',
        'validating',
        'completed',
        'rejected',
        'failed',
        'expired',
        'terminated',
      ],
    })
      .notNull()
      .default('created'),
    expectedBytes: integer('expected_bytes'),
    receivedBytes: integer('received_bytes').notNull().default(0),
    checksumAlgorithm: text('checksum_algorithm', { enum: ['sha256'] }),
    expectedChecksum: text('expected_checksum'),
    actualChecksum: text('actual_checksum'),
    originalFilename: text('original_filename'),
    declaredMimeType: text('declared_mime_type'),
    detectedMimeType: text('detected_mime_type'),
    uploadMetadata: text('upload_metadata'),
    idempotencyKey: text('idempotency_key'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    errorCode: text('error_code'),
    createdBy: text('created_by')
      .notNull()
      .references(() => authSchema.user.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'uploads_project_organization_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.assetId, table.organizationId, table.projectId],
      foreignColumns: [assets.id, assets.organizationId, assets.projectId],
      name: 'uploads_asset_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.storageObjectId, table.organizationId, table.projectId],
      foreignColumns: [storageObjects.id, storageObjects.organizationId, storageObjects.projectId],
      name: 'uploads_storage_object_tenant_fk',
    }).onDelete('restrict'),
    uniqueIndex('uploads_project_idempotency_unique').on(table.projectId, table.idempotencyKey),
    index('uploads_project_state_idx').on(table.organizationId, table.projectId, table.state),
    index('uploads_expiry_idx').on(table.state, table.expiresAt),
    check(
      'uploads_expected_bytes_nonnegative',
      sql`${table.expectedBytes} IS NULL OR ${table.expectedBytes} >= 0`,
    ),
    check('uploads_received_bytes_nonnegative', sql`${table.receivedBytes} >= 0`),
    check(
      'uploads_received_within_expected',
      sql`${table.expectedBytes} IS NULL OR ${table.receivedBytes} <= ${table.expectedBytes}`,
    ),
    check(
      'uploads_checksum_pair',
      sql`(${table.checksumAlgorithm} IS NULL) = (${table.expectedChecksum} IS NULL)`,
    ),
    check(
      'uploads_state_valid',
      sql`${table.state} IN ('created', 'receiving', 'validating', 'completed', 'rejected', 'failed', 'expired', 'terminated')`,
    ),
    check(
      'uploads_expected_checksum_valid',
      sql`${table.expectedChecksum} IS NULL OR (length(${table.expectedChecksum}) = 64 AND ${table.expectedChecksum} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      'uploads_actual_checksum_valid',
      sql`${table.actualChecksum} IS NULL OR (length(${table.actualChecksum}) = 64 AND ${table.actualChecksum} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
)

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    type: text('type').notNull(),
    state: text('state', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: integer('run_after', { mode: 'timestamp_ms' }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdBy: text('created_by').references(() => authSchema.user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'jobs_project_organization_fk',
    }).onDelete('cascade'),
    index('jobs_queue_idx').on(table.state, table.runAfter, table.leaseExpiresAt),
    index('jobs_project_created_idx').on(table.organizationId, table.projectId, table.createdAt),
    check('jobs_progress_range', sql`${table.progress} BETWEEN 0 AND 100`),
    check('jobs_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check('jobs_max_attempts_positive', sql`${table.maxAttempts} > 0`),
    check('jobs_attempts_within_max', sql`${table.attempts} <= ${table.maxAttempts}`),
    check(
      'jobs_state_valid',
      sql`${table.state} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'jobs_lease_consistent',
      sql`(${table.state} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.completedAt} IS NULL) OR (${table.state} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      'jobs_completion_consistent',
      sql`(${table.state} IN ('succeeded', 'failed', 'cancelled')) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'jobs_success_progress_complete',
      sql`${table.state} <> 'succeeded' OR ${table.progress} = 100`,
    ),
  ],
)

export const aiProjectSettings = sqliteTable(
  'ai_project_settings',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    allowPrivateAssets: integer('allow_private_assets', { mode: 'boolean' })
      .notNull()
      .default(false),
    monthlyBudgetMicroUsd: integer('monthly_budget_micro_usd').notNull().default(0),
    maxAssetsPerRun: integer('max_assets_per_run').notNull().default(100),
    concurrency: integer('concurrency').notNull().default(1),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').references(() => authSchema.user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'ai_project_settings_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('ai_project_settings_project_unique').on(table.organizationId, table.projectId),
    check('ai_project_settings_budget_nonnegative', sql`${table.monthlyBudgetMicroUsd} >= 0`),
    check(
      'ai_project_settings_asset_limit_valid',
      sql`${table.maxAssetsPerRun} BETWEEN 1 AND 10000`,
    ),
    check('ai_project_settings_concurrency_valid', sql`${table.concurrency} BETWEEN 1 AND 16`),
    check('ai_project_settings_version_positive', sql`${table.version} > 0`),
  ],
)

export const aiIndexes = sqliteTable(
  'ai_indexes',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    state: text('state', {
      enum: ['building', 'evaluating', 'active', 'retired', 'failed'],
    })
      .notNull()
      .default('building'),
    provider: text('provider').notNull(),
    visionModel: text('vision_model').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    dimensions: integer('dimensions').notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    collectionName: text('collection_name').notNull(),
    indexedAssets: integer('indexed_assets').notNull().default(0),
    errorCode: text('error_code'),
    createdBy: text('created_by').references(() => authSchema.user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    evaluatedAt: integer('evaluated_at', { mode: 'timestamp_ms' }),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'ai_indexes_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('ai_indexes_collection_unique').on(table.collectionName),
    uniqueIndex('ai_indexes_one_active_per_project')
      .on(table.organizationId, table.projectId)
      .where(sql`${table.state} = 'active'`),
    index('ai_indexes_project_state_idx').on(
      table.organizationId,
      table.projectId,
      table.state,
      table.createdAt,
    ),
    check(
      'ai_indexes_state_valid',
      sql`${table.state} IN ('building', 'evaluating', 'active', 'retired', 'failed')`,
    ),
    check('ai_indexes_dimensions_valid', sql`${table.dimensions} BETWEEN 1 AND 65536`),
    check('ai_indexes_count_nonnegative', sql`${table.indexedAssets} >= 0`),
  ],
)

export const aiIndexRecords = sqliteTable(
  'ai_index_records',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    indexId: text('index_id')
      .notNull()
      .references(() => aiIndexes.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').notNull(),
    assetVersionId: text('asset_version_id').notNull(),
    pointId: text('point_id').notNull(),
    contentKind: text('content_kind', {
      enum: ['image', 'video_keyframe', 'document_chunk', 'document_preview'],
    }).notNull(),
    chunkOrdinal: integer('chunk_ordinal').notNull().default(0),
    sourceText: text('source_text'),
    caption: text('caption'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.organizationId, table.projectId],
      foreignColumns: [assets.id, assets.organizationId, assets.projectId],
      name: 'ai_index_records_asset_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.assetVersionId, table.organizationId, table.projectId],
      foreignColumns: [assetVersions.id, assetVersions.organizationId, assetVersions.projectId],
      name: 'ai_index_records_asset_version_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('ai_index_records_point_unique').on(table.pointId),
    uniqueIndex('ai_index_records_source_unique').on(
      table.indexId,
      table.assetVersionId,
      table.contentKind,
      table.chunkOrdinal,
    ),
    index('ai_index_records_project_asset_idx').on(
      table.organizationId,
      table.projectId,
      table.assetId,
    ),
    check('ai_index_records_chunk_nonnegative', sql`${table.chunkOrdinal} >= 0`),
    check('ai_index_records_dimensions_valid', sql`${table.dimensions} BETWEEN 1 AND 65536`),
  ],
)

export const aiAssetExclusions = sqliteTable(
  'ai_asset_exclusions',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    assetId: text('asset_id').notNull(),
    createdBy: text('created_by').references(() => authSchema.user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.organizationId, table.projectId],
      foreignColumns: [assets.id, assets.organizationId, assets.projectId],
      name: 'ai_asset_exclusions_asset_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('ai_asset_exclusions_asset_unique').on(
      table.organizationId,
      table.projectId,
      table.assetId,
    ),
  ],
)

export const aiUsageLedger = sqliteTable(
  'ai_usage_ledger',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    indexId: text('index_id').references(() => aiIndexes.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    operation: text('operation', { enum: ['caption', 'embedding'] }).notNull(),
    inputUnits: integer('input_units').notNull().default(0),
    outputUnits: integer('output_units').notNull().default(0),
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'ai_usage_ledger_project_organization_fk',
    }).onDelete('cascade'),
    index('ai_usage_ledger_project_occurred_idx').on(
      table.organizationId,
      table.projectId,
      table.occurredAt,
    ),
    check('ai_usage_input_nonnegative', sql`${table.inputUnits} >= 0`),
    check('ai_usage_output_nonnegative', sql`${table.outputUnits} >= 0`),
    check('ai_usage_cost_nonnegative', sql`${table.costMicroUsd} >= 0`),
  ],
)

export const semanticEvaluations = sqliteTable(
  'semantic_evaluations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    indexId: text('index_id')
      .notNull()
      .references(() => aiIndexes.id, { onDelete: 'cascade' }),
    evaluationVersion: text('evaluation_version').notNull(),
    queryCount: integer('query_count').notNull(),
    recallAt10Millionths: integer('recall_at_10_millionths').notNull(),
    ndcgAt10Millionths: integer('ndcg_at_10_millionths').notNull(),
    tenantFilterFailures: integer('tenant_filter_failures').notNull().default(0),
    approved: integer('approved', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: 'semantic_evaluations_project_organization_fk',
    }).onDelete('cascade'),
    uniqueIndex('semantic_evaluations_index_version_unique').on(
      table.indexId,
      table.evaluationVersion,
    ),
    check('semantic_evaluations_query_count_positive', sql`${table.queryCount} > 0`),
    check(
      'semantic_evaluations_recall_range',
      sql`${table.recallAt10Millionths} BETWEEN 0 AND 1000000`,
    ),
    check(
      'semantic_evaluations_ndcg_range',
      sql`${table.ndcgAt10Millionths} BETWEEN 0 AND 1000000`,
    ),
    check(
      'semantic_evaluations_filter_failures_nonnegative',
      sql`${table.tenantFilterFailures} >= 0`,
    ),
  ],
)

export const assetSearchDocuments = sqliteTable(
  'asset_search_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => authSchema.organization.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    assetId: text('asset_id').notNull(),
    publicId: text('public_id').notNull(),
    name: text('name').notNull(),
    folder: text('folder').notNull().default(''),
    metadataText: text('metadata_text').notNull().default(''),
    extractedText: text('extracted_text').notNull().default(''),
    caption: text('caption').notNull().default(''),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.organizationId, table.projectId],
      foreignColumns: [assets.id, assets.organizationId, assets.projectId],
      name: 'asset_search_documents_asset_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('asset_search_documents_asset_unique').on(
      table.organizationId,
      table.projectId,
      table.assetId,
    ),
    index('asset_search_documents_project_idx').on(table.organizationId, table.projectId),
  ],
)

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => authSchema.organization.id, {
      onDelete: 'restrict',
    }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    actorType: text('actor_type', { enum: ['user', 'api_key', 'system'] }).notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    requestId: text('request_id').notNull(),
    summary: text('summary', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('audit_events_organization_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_project_created_idx').on(table.projectId, table.createdAt),
    index('audit_events_request_id_idx').on(table.requestId),
  ],
)

export const schema = {
  ...authSchema,
  aiAssetExclusions,
  aiIndexRecords,
  aiIndexes,
  aiProjectSettings,
  aiUsageLedger,
  assets,
  assetSearchDocuments,
  assetVersions,
  auditEvents,
  jobs,
  projectMembers,
  projectApiKeys,
  projects,
  storageObjects,
  semanticEvaluations,
  systemSettings,
  uploads,
}
