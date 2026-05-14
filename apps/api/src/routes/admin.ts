import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { db } from 'shared/db'
import { apiKeyAuth } from '../middleware/apiKeyAuth'

export const adminRouter = Router()

// ── Setup status (public — dashboard calls this on first load) ────────────────

/**
 * GET /admin/setup-status
 *
 * Returns whether the first-run setup has been completed.
 * The dashboard uses this to decide whether to show /setup or /login.
 * This endpoint is intentionally public — no API key required.
 */
adminRouter.get('/setup-status', (_req, res) => {
  const row = db.prepare('SELECT COUNT(*) as count FROM "user"').get() as { count: number }
  res.json({ setupComplete: row.count > 0 })
})

// ── Stats (protected) ─────────────────────────────────────────────────────────

/**
 * GET /admin/stats
 *
 * Returns storage usage, file counts, and system info.
 * Requires a valid API key.
 */
adminRouter.get('/stats', apiKeyAuth, async (_req, res, next) => {
  try {
    const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
    const cacheDir  = process.env.CACHE_DIR  ?? path.join(process.cwd(), 'cache')

    const [uploadSize, cacheSize] = await Promise.all([
      getDirSize(uploadDir),
      getDirSize(cacheDir),
    ])

    const fileCount = (db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number }).count

    const byMime = db.prepare(`
      SELECT mime_type, COUNT(*) as count, SUM(size) as total_size
      FROM files
      GROUP BY mime_type
      ORDER BY total_size DESC
    `).all() as { mime_type: string; count: number; total_size: number }[]

    const recentFiles = db.prepare(`
      SELECT key, name, mime_type, size, created_at
      FROM files
      ORDER BY created_at DESC
      LIMIT 5
    `).all()

    res.json({
      storage: {
        uploads: {
          bytes: uploadSize,
          human: formatBytes(uploadSize),
        },
        cache: {
          bytes: cacheSize,
          human: formatBytes(cacheSize),
        },
        total: {
          bytes: uploadSize + cacheSize,
          human: formatBytes(uploadSize + cacheSize),
        },
      },
      files: {
        total: fileCount,
        byMimeType: byMime,
      },
      recent: recentFiles,
      system: {
        storageBackend: process.env.STORAGE_ENDPOINT ? 's3' : 'local',
        uploadDir,
        cacheDir,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /admin/cache
 *
 * Clears the entire transform cache directory.
 * Requires a valid API key.
 * Useful after bulk-updating files or changing transform defaults.
 */
adminRouter.delete('/cache', apiKeyAuth, async (_req, res, next) => {
  try {
    const cacheDir = process.env.CACHE_DIR ?? path.join(process.cwd(), 'cache')

    let cleared = 0
    try {
      const entries = await fs.readdir(cacheDir)
      await Promise.all(
        entries.map(async (entry) => {
          await fs.unlink(path.join(cacheDir, entry))
          cleared++
        })
      )
    } catch {
      // Cache dir doesn't exist yet — that's fine
    }

    res.json({ cleared, message: `Cleared ${cleared} cached file(s)` })
  } catch (err) {
    next(err)
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getDirSize(dirPath: string): Promise<number> {
  let total = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          total += await getDirSize(fullPath)
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath)
          total += stat.size
        }
      })
    )
  } catch {
    // Directory doesn't exist yet
  }
  return total
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}