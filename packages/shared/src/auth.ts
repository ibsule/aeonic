import { betterAuth } from 'better-auth'
import { apiKey } from '@better-auth/api-key'
import { db } from './db'

export const auth = betterAuth({
  database: {
    db,
    type: 'sqlite',
  },
  plugins: [
    apiKey({
      defaultPrefix: 'ac_',
    }),
  ],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  // Session lasts 30 days
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24, // Refresh session if it's older than 1 day
  },
  trustedOrigins: [
    process.env.PUBLIC_URL ?? 'http://localhost:3000',
    process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  ],
})

export type Auth = typeof auth