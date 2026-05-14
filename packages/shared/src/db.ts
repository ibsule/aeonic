import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), '../../data/db.sqlite')

// Ensure the directory exists before opening the database
const dbDir = path.dirname(dbPath)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

export const db = new Database(dbPath)

// WAL mode: allows concurrent reads while a write is in progress.
db.pragma('journal_mode = WAL')

db.pragma('foreign_keys = ON')

runMigrations()

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "session" (
      id TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "account" (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope TEXT,
      password TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "verification" (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER,
      updatedAt INTEGER
    );

    -- API keys (managed by better-auth apiKey plugin)
    CREATE TABLE IF NOT EXISTS "apikey" (
      id TEXT PRIMARY KEY,
      name TEXT,
      start TEXT,
      prefix TEXT,
      key TEXT NOT NULL UNIQUE,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      refillInterval INTEGER,
      refillAmount INTEGER,
      lastRefillAt INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      rateLimitEnabled INTEGER NOT NULL DEFAULT 1,
      rateLimitTimeWindow INTEGER,
      rateLimitMax INTEGER,
      requestCount INTEGER NOT NULL DEFAULT 0,
      remaining INTEGER,
      lastRequest INTEGER,
      expiresAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      permissions TEXT,
      metadata TEXT
    );

    -- Uploaded files index
    CREATE TABLE IF NOT EXISTS "files" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_files_key ON files(key);
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
    CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
  `)
}