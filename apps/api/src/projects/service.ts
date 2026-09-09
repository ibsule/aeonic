import type {
  CreateProjectRequest,
  Project,
  ProjectList,
  UpdateProjectRequest,
} from '@aeonic/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  parseOrganizationRole,
  roleAllows,
  roleHasOrganizationWideProjectAccess,
  type OrganizationRole,
  type ProjectAction,
} from '../authorization/policy.js'
import type { DatabaseConnection } from '../db/database.js'
import { auditEvents, member, projectMembers, projects } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'

interface ProjectRow {
  id: string
  organizationId: string
  name: string
  slug: string
  version: number
  createdAt: Date
  updatedAt: Date
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function forbidden(): ApiError {
  return new ApiError(403, 'Access denied', 'access_denied', 'You cannot perform this action.')
}

function notFound(): ApiError {
  return new ApiError(404, 'Project not found', 'project_not_found', 'The project does not exist.')
}

export function projectEtag(project: Pick<Project, 'id' | 'version'>): string {
  return `"project-${project.id}-v${project.version}"`
}

export class ProjectService {
  constructor(private readonly database: DatabaseConnection) {}

  organizationRoleFor(userId: string, organizationId: string): OrganizationRole {
    const membership = this.database.db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
      .get()
    const role = membership ? parseOrganizationRole(membership.role) : null
    if (!role) throw forbidden()
    return role
  }

  authorize(
    userId: string,
    organizationId: string,
    projectId: string,
    action: ProjectAction,
  ): OrganizationRole {
    const role = this.organizationRoleFor(userId, organizationId)
    if (!roleAllows(role, action)) throw forbidden()
    if (!roleHasOrganizationWideProjectAccess(role)) {
      const assignment = this.database.db
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, userId),
            eq(projectMembers.organizationId, organizationId),
            eq(projectMembers.projectId, projectId),
          ),
        )
        .get()
      if (!assignment) throw forbidden()
    }
    return role
  }

  list(userId: string, organizationId: string): ProjectList {
    const role = this.organizationRoleFor(userId, organizationId)
    const selection = {
      id: projects.id,
      organizationId: projects.organizationId,
      name: projects.name,
      slug: projects.slug,
      version: projects.version,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    }
    const rows = roleHasOrganizationWideProjectAccess(role)
      ? this.database.db
          .select(selection)
          .from(projects)
          .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
          .all()
      : this.database.db
          .select(selection)
          .from(projects)
          .innerJoin(
            projectMembers,
            and(
              eq(projectMembers.projectId, projects.id),
              eq(projectMembers.organizationId, projects.organizationId),
            ),
          )
          .where(
            and(
              eq(projects.organizationId, organizationId),
              eq(projectMembers.userId, userId),
              isNull(projects.deletedAt),
            ),
          )
          .all()
    return { items: rows.map(toProject) }
  }

  get(userId: string, organizationId: string, projectId: string): Project {
    this.authorize(userId, organizationId, projectId, 'read')
    const row = this.database.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        name: projects.name,
        slug: projects.slug,
        version: projects.version,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
        ),
      )
      .get()
    if (!row) throw notFound()
    return toProject(row)
  }

  create(
    userId: string,
    organizationId: string,
    input: CreateProjectRequest,
    requestId: string,
  ): Project {
    const role = this.organizationRoleFor(userId, organizationId)
    if (!roleAllows(role, 'create')) throw forbidden()
    const now = new Date()
    const row: ProjectRow = {
      id: uuidv7(),
      organizationId,
      name: input.name.trim(),
      slug: input.slug,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }

    try {
      this.database.db.transaction((transaction) => {
        transaction
          .insert(projects)
          .values({ ...row, createdBy: userId })
          .run()
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId,
            projectId: row.id,
            actorType: 'user',
            actorId: userId,
            action: 'project.created',
            targetType: 'project',
            targetId: row.id,
            requestId,
            summary: { name: row.name, slug: row.slug },
            createdAt: now,
          })
          .run()
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ApiError(
          409,
          'Project slug unavailable',
          'project_slug_conflict',
          'A project with this slug already exists in the organization.',
        )
      }
      throw error
    }
    return toProject(row)
  }

  update(
    userId: string,
    organizationId: string,
    projectId: string,
    expectedEtag: string | undefined,
    input: UpdateProjectRequest,
    requestId: string,
  ): Project {
    this.authorize(userId, organizationId, projectId, 'update')
    const current = this.get(userId, organizationId, projectId)
    if (!expectedEtag) {
      throw new ApiError(428, 'Precondition required', 'if_match_required', 'Provide If-Match.')
    }
    if (expectedEtag !== projectEtag(current)) {
      throw new ApiError(412, 'Precondition failed', 'etag_mismatch', 'The project has changed.')
    }

    const now = new Date()
    const next: Project = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      version: current.version + 1,
      updatedAt: now.toISOString(),
    }
    try {
      this.database.db.transaction((transaction) => {
        const changed = transaction
          .update(projects)
          .set({ name: next.name, slug: next.slug, version: next.version, updatedAt: now })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, organizationId),
              eq(projects.version, current.version),
              isNull(projects.deletedAt),
            ),
          )
          .run()
        if (changed.changes !== 1) {
          throw new ApiError(
            412,
            'Precondition failed',
            'etag_mismatch',
            'The project has changed.',
          )
        }
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId,
            projectId,
            actorType: 'user',
            actorId: userId,
            action: 'project.updated',
            targetType: 'project',
            targetId: projectId,
            requestId,
            summary: { before: current, after: next },
            createdAt: now,
          })
          .run()
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ApiError(
          409,
          'Project slug unavailable',
          'project_slug_conflict',
          'A project with this slug already exists in the organization.',
        )
      }
      throw error
    }
    return next
  }

  delete(
    userId: string,
    organizationId: string,
    projectId: string,
    expectedEtag: string | undefined,
    requestId: string,
  ): void {
    this.authorize(userId, organizationId, projectId, 'delete')
    const current = this.get(userId, organizationId, projectId)
    if (!expectedEtag) {
      throw new ApiError(428, 'Precondition required', 'if_match_required', 'Provide If-Match.')
    }
    if (expectedEtag !== projectEtag(current)) {
      throw new ApiError(412, 'Precondition failed', 'etag_mismatch', 'The project has changed.')
    }
    const now = new Date()
    this.database.db.transaction((transaction) => {
      const changed = transaction
        .update(projects)
        .set({ deletedAt: now, updatedAt: now, version: current.version + 1 })
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.organizationId, organizationId),
            eq(projects.version, current.version),
            isNull(projects.deletedAt),
          ),
        )
        .run()
      if (changed.changes !== 1) {
        throw new ApiError(412, 'Precondition failed', 'etag_mismatch', 'The project has changed.')
      }
      transaction
        .insert(auditEvents)
        .values({
          id: uuidv7(),
          organizationId,
          projectId,
          actorType: 'user',
          actorId: userId,
          action: 'project.deleted',
          targetType: 'project',
          targetId: projectId,
          requestId,
          summary: { name: current.name, slug: current.slug },
          createdAt: now,
        })
        .run()
    })
  }
}
