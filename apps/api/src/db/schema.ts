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
    state: text('state', { enum: ['pending', 'ready', 'failed', 'deleted'] })
      .notNull()
      .default('pending'),
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
    state: text('state', { enum: ['pending', 'ready', 'failed'] })
      .notNull()
      .default('pending'),
    storageKey: text('storage_key'),
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
  systemSettings,
}
