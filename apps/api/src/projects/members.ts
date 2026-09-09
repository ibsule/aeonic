import type {
  AssignProjectMemberRequest,
  ProjectMember,
  ProjectMemberList,
} from '@aeonic/contracts'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { parseOrganizationRole } from '../authorization/policy.js'
import type { DatabaseConnection } from '../db/database.js'
import { auditEvents, member, projectMembers, user } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { ProjectService } from './service.js'

export class ProjectMemberService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
  ) {}

  list(actorId: string, organizationId: string, projectId: string): ProjectMemberList {
    this.projects.authorize(actorId, organizationId, projectId, 'read')
    const rows = this.database.db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        role: member.role,
        assignedAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .innerJoin(
        member,
        and(
          eq(member.userId, projectMembers.userId),
          eq(member.organizationId, projectMembers.organizationId),
        ),
      )
      .where(
        and(
          eq(projectMembers.organizationId, organizationId),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .all()
    return {
      items: rows.flatMap((row): ProjectMember[] => {
        const role = parseOrganizationRole(row.role)
        return role
          ? [
              {
                userId: row.userId,
                name: row.name,
                email: row.email,
                role,
                assignedAt: row.assignedAt.toISOString(),
              },
            ]
          : []
      }),
    }
  }

  assign(
    actorId: string,
    organizationId: string,
    projectId: string,
    input: AssignProjectMemberRequest,
    requestId: string,
  ): ProjectMember {
    this.projects.authorize(actorId, organizationId, projectId, 'update')
    const organizationMember = this.database.db
      .select({ name: user.name, email: user.email, role: member.role })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, input.userId)))
      .get()
    const role = organizationMember ? parseOrganizationRole(organizationMember.role) : null
    if (!organizationMember || !role) {
      throw new ApiError(
        422,
        'Organization membership required',
        'organization_membership_required',
        'The user must belong to the organization before project assignment.',
      )
    }
    const now = new Date()
    try {
      this.database.db.transaction((transaction) => {
        transaction
          .insert(projectMembers)
          .values({
            id: uuidv7(),
            organizationId,
            projectId,
            userId: input.userId,
            createdBy: actorId,
            createdAt: now,
          })
          .run()
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId,
            projectId,
            actorType: 'user',
            actorId,
            action: 'project.member_assigned',
            targetType: 'user',
            targetId: input.userId,
            requestId,
            createdAt: now,
          })
          .run()
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ApiError(
          409,
          'Member already assigned',
          'project_member_conflict',
          'The member is already assigned to this project.',
        )
      }
      throw error
    }
    return {
      userId: input.userId,
      name: organizationMember.name,
      email: organizationMember.email,
      role,
      assignedAt: now.toISOString(),
    }
  }

  remove(
    actorId: string,
    organizationId: string,
    projectId: string,
    userId: string,
    requestId: string,
  ): void {
    this.projects.authorize(actorId, organizationId, projectId, 'update')
    const now = new Date()
    this.database.db.transaction((transaction) => {
      const removed = transaction
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.organizationId, organizationId),
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        )
        .run()
      if (removed.changes !== 1) {
        throw new ApiError(
          404,
          'Project member not found',
          'project_member_not_found',
          'The project assignment does not exist.',
        )
      }
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId,
          projectId,
          actorType: 'user',
          actorId,
          action: 'project.member_removed',
          targetType: 'user',
          targetId: userId,
          requestId,
          createdAt: now,
        })
        .run()
    })
  }
}
