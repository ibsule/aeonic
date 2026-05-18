import { Request, Response, NextFunction } from 'express'
import { db } from 'shared/db'

/**
 * Blocks access to protected routes if no admin user has been created yet.
 * The dashboard will redirect to /setup when it receives this response.
 */
export function requireSetup(req: Request, res: Response, next: NextFunction): void {
  const row = db.prepare('SELECT COUNT(*) as count FROM "user"').get() as { count: number }
  if (row.count === 0) {
    res.status(403).json({
      error: 'Setup required',
      setup: true,
      message: 'No admin account exists. Please complete setup at /setup',
    })
    return
  }
  next()
}