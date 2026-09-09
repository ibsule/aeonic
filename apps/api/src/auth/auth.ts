import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import * as databaseSchema from '../db/schema.js'
import { createAuthPlugins } from './plugins.js'

export interface AuthService {
  handler(request: Request): Promise<Response>
  getSession(headers: Headers): Promise<AuthSession | null>
  createOrganizationApiKey(input: CreateOrganizationApiKeyInput): Promise<CreatedApiKey>
  verifyApiKey(key: string): Promise<VerifiedApiKey | null>
}

export interface AuthSession {
  session: {
    id: string
    userId: string
  }
  user: {
    id: string
    name: string
    email: string
  }
}

export interface CreateOrganizationApiKeyInput {
  organizationId: string
  userId: string
  projectId: string
  name: string
  permissions: Record<string, string[]>
  expiresIn?: number
}

export interface CreatedApiKey {
  id: string
  key: string
  name: string | null
  start: string | null
  prefix: string | null
  expiresAt: Date | null
  createdAt: Date
}

export interface VerifiedApiKey {
  id: string
  organizationId: string
  projectId: string
  permissions: Record<string, string[]>
}

export function createAuth(config: AppConfig, database: DatabaseConnection): AuthService {
  const auth = betterAuth({
    appName: 'Aeonic',
    baseURL: config.authBaseUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [...config.corsOrigins],
    logger: {
      disabled: config.environment === 'test',
    },
    database: drizzleAdapter(database.db, {
      provider: 'sqlite',
      schema: databaseSchema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    advanced: {
      database: {
        generateId: () => uuidv7(),
        joins: true,
      },
      useSecureCookies: config.environment === 'production',
    },
    plugins: createAuthPlugins(),
    telemetry: {
      enabled: false,
    },
  })

  return {
    handler: auth.handler,
    getSession: async (headers) => {
      const session = await auth.api.getSession({ headers })
      if (!session) return null
      return {
        session: {
          id: session.session.id,
          userId: session.session.userId,
        },
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
      }
    },
    createOrganizationApiKey: async (input) => {
      const created = await auth.api.createApiKey({
        body: {
          organizationId: input.organizationId,
          userId: input.userId,
          name: input.name,
          prefix: 'aek_',
          metadata: { projectId: input.projectId },
          permissions: input.permissions,
          ...(input.expiresIn === undefined ? {} : { expiresIn: input.expiresIn }),
        },
      })
      return {
        id: created.id,
        key: created.key,
        name: created.name,
        start: created.start,
        prefix: created.prefix,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
      }
    },
    verifyApiKey: async (key) => {
      const result = await auth.api.verifyApiKey({ body: { key } })
      if (!result.valid || !result.key) return null
      const metadata = result.key.metadata as { projectId?: unknown } | null
      if (typeof metadata?.projectId !== 'string') return null
      return {
        id: result.key.id,
        organizationId: result.key.referenceId,
        projectId: metadata.projectId,
        permissions: result.key.permissions ?? {},
      }
    },
  }
}
