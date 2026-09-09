import type { AuditEventList } from '@aeonic/contracts'
import { validate as isUuid } from 'uuid'
import { roleAllows } from '../authorization/policy.js'
import { ApiError } from '../http/api-error.js'
import type { AuditRepository } from '../repositories/types.js'
import type { ProjectService } from '../projects/service.js'

export interface ListAuditEventsOptions {
  projectId?: string
  cursor?: string
  limit: number
}

function denied(): ApiError {
  return new ApiError(403, 'Access denied', 'access_denied', 'You cannot view audit events.')
}

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly projects: ProjectService,
  ) {}

  list(actorId: string, organizationId: string, options: ListAuditEventsOptions): AuditEventList {
    const role = this.projects.organizationRoleFor(actorId, organizationId)
    if (!roleAllows(role, 'read_audit')) throw denied()
    if (options.cursor && !isUuid(options.cursor)) {
      throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
    }
    if (options.projectId) {
      this.projects.get(actorId, organizationId, options.projectId)
    }

    const page = this.repository.listOrganizationEvents(organizationId, options)
    return {
      items: page.items.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    }
  }
}
