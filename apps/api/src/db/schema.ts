import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
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
    index('project_api_keys_project_idx').on(table.organizationId, table.projectId),
    index('project_api_keys_created_by_idx').on(table.createdBy),
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
  auditEvents,
  projectMembers,
  projectApiKeys,
  projects,
  systemSettings,
}
