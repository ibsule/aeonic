import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { betterAuth } from 'better-auth'
import { v7 as uuidv7 } from 'uuid'
import type { AppConfig } from '../config.js'
import type { DatabaseConnection } from '../db/database.js'
import * as databaseSchema from '../db/schema.js'
import { createAuthPlugins } from './plugins.js'

export interface AuthService {
  handler(request: Request): Promise<Response>
}

export function createAuth(config: AppConfig, database: DatabaseConnection): AuthService {
  return betterAuth({
    appName: 'Aeonic',
    baseURL: config.authBaseUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [...config.corsOrigins],
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
}
