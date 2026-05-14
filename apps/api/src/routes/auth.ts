import { Router, Request, Response } from 'express'
import { auth } from 'shared/auth'
import { db } from 'shared/db'
import { toNodeHandler } from 'better-auth/node'

export const authRouter = Router()

// ── Registration guard ────────────────────────────────────────────────────────
// Aeonic is single-tenant: only the first user (the admin) can sign up.
// After that, registration is closed. New users must be invited by the admin
// (a Phase 3 feature). This middleware enforces that at the API level.

function registrationGuard(req: Request, res: Response, next: Function) {
  const isSignUp =
    req.method === 'POST' &&
    req.path.includes('sign-up')

  if (!isSignUp) return next()

  const row = db.prepare('SELECT COUNT(*) as count FROM "user"').get() as { count: number }

  if (row.count > 0) {
    res.status(403).json({
      error: 'Registration is closed',
      message: 'This Aeonic instance already has an admin account. Additional users must be invited by the admin.',
    })
    return
  }

  // First user — allow sign-up to proceed
  next()
}

// ── better-auth handler ───────────────────────────────────────────────────────
// better-auth exposes a single fetch handler. toNodeHandler() adapts it
// to Express's req/res interface. All auth routes (/sign-in, /sign-up,
// /sign-out, /session, /api-key/*) are handled here automatically.

const betterAuthHandler = toNodeHandler(auth)

authRouter.use(registrationGuard)
authRouter.all('*', betterAuthHandler)