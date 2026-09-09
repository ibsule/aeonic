import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { v7 as uuidv7 } from 'uuid'
import { createAuthPlugins } from './plugins.js'

interface SchemaAuth {
  handler(request: Request): Promise<Response>
  options: BetterAuthOptions
}

export const auth: SchemaAuth = betterAuth({
  appName: 'Aeonic',
  basePath: '/api/auth',
  secret: 'schema-generation-only-secret-value',
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    database: {
      generateId: () => uuidv7(),
    },
  },
  plugins: createAuthPlugins(),
  telemetry: {
    enabled: false,
  },
})
