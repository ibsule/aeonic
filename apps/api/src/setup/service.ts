import type { SetupRequest, SetupResult, SetupStatus } from '@aeonic/contracts'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import {
  account,
  auditEvents,
  member,
  organization,
  projectMembers,
  projects,
  systemSettings,
  user,
} from '../db/schema.js'

const setupCompletedKey = 'setup.completed'

export class SetupAlreadyCompleteError extends Error {
  override readonly name = 'SetupAlreadyCompleteError'
}

export class SetupService {
  constructor(private readonly database: DatabaseConnection) {}

  status(): SetupStatus {
    const completed = this.database.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(eq(systemSettings.key, setupCompletedKey))
      .get()
    return { status: completed ? 'complete' : 'required' }
  }

  async initialize(input: SetupRequest, requestId: string): Promise<SetupResult> {
    const password = await hashPassword(input.password)
    const now = new Date()
    const result: SetupResult = {
      userId: uuidv7(),
      organizationId: uuidv7(),
      projectId: uuidv7(),
    }

    try {
      this.database.db.transaction((transaction) => {
        transaction
          .insert(systemSettings)
          .values({
            key: setupCompletedKey,
            value: JSON.stringify({ completedAt: now.toISOString() }),
            updatedAt: now,
          })
          .run()

        transaction
          .insert(user)
          .values({
            id: result.userId,
            name: input.name.trim(),
            email: input.email.trim().toLowerCase(),
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(account)
          .values({
            id: uuidv7(),
            accountId: result.userId,
            providerId: 'credential',
            userId: result.userId,
            password,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(organization)
          .values({
            id: result.organizationId,
            name: input.organizationName.trim(),
            slug: input.organizationSlug,
            createdAt: now,
          })
          .run()
        transaction
          .insert(member)
          .values({
            id: uuidv7(),
            organizationId: result.organizationId,
            userId: result.userId,
            role: 'owner',
            createdAt: now,
          })
          .run()
        transaction
          .insert(projects)
          .values({
            id: result.projectId,
            organizationId: result.organizationId,
            name: input.projectName.trim(),
            slug: input.projectSlug,
            createdBy: result.userId,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(projectMembers)
          .values({
            id: uuidv7(),
            organizationId: result.organizationId,
            projectId: result.projectId,
            userId: result.userId,
            createdBy: result.userId,
            createdAt: now,
          })
          .run()
        transaction
          .insert(auditEvents)
          .values({
            id: uuidv7(),
            organizationId: result.organizationId,
            projectId: result.projectId,
            actorType: 'user',
            actorId: result.userId,
            action: 'system.setup.completed',
            targetType: 'organization',
            targetId: result.organizationId,
            requestId,
            summary: { projectId: result.projectId },
            createdAt: now,
          })
          .run()
      })
    } catch (error) {
      if (this.status().status === 'complete') throw new SetupAlreadyCompleteError()
      throw error
    }

    return result
  }
}
