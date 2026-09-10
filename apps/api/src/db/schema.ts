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
  assets,
  assetVersions,
  auditEvents,
  jobs,
  projectMembers,
  projectApiKeys,
  projects,
  storageObjects,
  systemSettings,
  uploads,
}
