import { Router, type Router as RouterType } from 'express'
import multer from 'multer'
import crypto from 'crypto'
import path from 'path'
import { db } from 'shared/db'
import { getStorage } from '../utils/storage'
import { apiKeyAuth } from '../middleware/apiKeyAuth'
import { requireSetup } from '../middleware/requireSetup'
import { rateLimit } from '../middleware/rateLimit'
import { isAllowedMimeType } from '../utils/mime'

export const uploadRouter: RouterType = Router()

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE ?? '104857600', 10) // 100MB default

// multer with memoryStorage keeps the file as a Buffer in memory.
// For very large files in production you'd switch to diskStorage,
// but memoryStorage is simpler and fine for most self-hosted workloads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMimeType(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`))
    }
  },
})

/**
 * POST /upload
 *
 * Upload a single file. Requires a valid API key.
 *
 * Form fields:
 *   file    (required) — the file to upload
 *   folder  (optional) — logical folder, e.g. "products/shoes"
 *
 * Returns:
 *   { key, name, url, size, mime_type }
 */
uploadRouter.post(
  '/',
  requireSetup,
  apiKeyAuth,
  rateLimit(50),                        // 50 uploads per minute per key
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided. Send a multipart/form-data request with field name "file".' })
        return
      }

      const { buffer, originalname, mimetype, size } = req.file
      const folder = (req.body.folder as string | undefined)?.replace(/^\/+|\/+$/g, '') ?? ''

      // Build a unique storage key
      // Format: [folder/]timestamp-randomhex.ext
      // e.g. "products/shoes/1716000000000-a1b2c3d4.jpg"
      const ext = path.extname(originalname).toLowerCase()
      const uniquePart = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
      const key = folder ? `${folder}/${uniquePart}${ext}` : `${uniquePart}${ext}`

      const storage = getStorage()
      await storage.write(key, buffer, mimetype)

      // Record in the files table
      db.prepare(`
        INSERT INTO files (key, name, folder, mime_type, size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(key, originalname, folder, mimetype, size, res.locals.userId ?? null)

      res.status(201).json({
        key,
        name: originalname,
        url: storage.publicUrl(key),
        size,
        mime_type: mimetype,
      })
    } catch (err) {
      next(err)
    }
  }
)