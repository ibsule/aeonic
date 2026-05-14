import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'

import { uploadRouter } from './routes/upload'
import { filesRouter } from './routes/files'
import { adminRouter } from './routes/admin'
import { authRouter } from './routes/auth'
import { errorHandler } from './middleware/errorHandler'

const app = express()

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  // Allow images to be served cross-origin (needed for the dashboard)
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  credentials: true,
}))

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: process.env.npm_package_version ?? '0.1.0' })
})

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/upload', uploadRouter)
app.use('/files', filesRouter)     // serve + list files
app.use('/admin', adminRouter)     // stats, setup check
app.use('/auth', authRouter)       // better-auth handler

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler)

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Aeonic API running on http://0.0.0.0:${PORT}`)
  console.log(`  Upload dir : ${process.env.UPLOAD_DIR ?? './uploads'}`)
  console.log(`  Cache dir  : ${process.env.CACHE_DIR ?? './cache'}`)
  console.log(`  DB path    : ${process.env.DB_PATH ?? './data/db.sqlite'}`)
  console.log(`  Storage    : ${process.env.STORAGE_ENDPOINT ? 'S3-compatible' : 'Local disk'}`)
})

export default app