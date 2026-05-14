import { Router, type Router as RouterType } from 'express'
import { db } from 'shared/db'
import { getStorage } from '../utils/storage'
import { getMimeType } from '../utils/mime'
import { apiKeyAuth } from '../middleware/apiKeyAuth'
import { requireSetup } from '../middleware/requireSetup'
import { rateLimit } from '../middleware/rateLimit'
import { FileListQuerySchema } from 'shared/types'

export const filesRouter: RouterType = Router()

/**
 * GET /files/:key(*)
 *
 * Serve the original file directly (no transformation).
 * Public endpoint — no API key required to serve files.
 * (If you want private files, add apiKeyAuth middleware here)
 */
filesRouter.get('/:key(*)', rateLimit(300), async (req, res, next) => {
  try {
    const key = req.params.key

    const storage = getStorage()
    const buffer = await storage.read(key)

    if (!buffer) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    const mimeType = getMimeType(key)

    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length),
      // Cache for 1 year — original files never change (they're content-addressed)
      'Cache-Control': 'public, max-age=31536000, immutable',
    })

    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

/**
 * GET /files
 *
 * List uploaded files. Requires API key.
 *
 * Query params:
 *   folder  — filter by folder
 *   page    — page number (default: 1)
 *   limit   — items per page (default: 20, max: 100)
 *   search  — search by file name
 */
filesRouter.get(
  '/',
  requireSetup,
  apiKeyAuth,
  rateLimit(120),
  (req, res, next) => {
    try {
      const parsed = FileListQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() })
        return
      }

      const { folder, page, limit, search } = parsed.data
      const offset = (page - 1) * limit

      // Build WHERE clause dynamically
      const conditions: string[] = []
      const params: (string | number)[] = []

      if (folder !== undefined) {
        conditions.push('folder = ?')
        params.push(folder)
      }
      if (search) {
        conditions.push('name LIKE ?')
        params.push(`%${search}%`)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const total = (db.prepare(`SELECT COUNT(*) as count FROM files ${where}`).get(...params) as { count: number }).count
      const files = db.prepare(`SELECT * FROM files ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)

      res.json({
        files,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * DELETE /files/:key(*)
 *
 * Delete a file from storage and the database. Requires API key.
 */
filesRouter.delete('/:key(*)', requireSetup, apiKeyAuth, async (req, res, next) => {
  try {
    const key = req.params.key

    const storage = getStorage()
    await storage.delete(key)

    db.prepare('DELETE FROM files WHERE key = ?').run(key)

    res.json({ deleted: true, key })
  } catch (err) {
    next(err)
  }
})