import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import type { DatabaseConnection } from '../db/database.js'
import { auditEvents } from '../db/schema.js'
import type { AuditEventPage, AuditRepository } from '../repositories/types.js'

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly database: DatabaseConnection) {}

  listOrganizationEvents(
    organizationId: string,
    options: { projectId?: string; cursor?: string; limit: number },
  ): AuditEventPage {
    const filters: SQL[] = [eq(auditEvents.organizationId, organizationId)]
    if (options.projectId) filters.push(eq(auditEvents.projectId, options.projectId))
    if (options.cursor) filters.push(lt(auditEvents.id, options.cursor))

    const rows = this.database.db
      .select()
      .from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.id))
      .limit(options.limit + 1)
      .all()
    const hasMore = rows.length > options.limit
    const items = hasMore ? rows.slice(0, options.limit) : rows
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    }
  }
}
