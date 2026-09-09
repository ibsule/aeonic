import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AppConfig } from '../config.js'
import * as schema from './schema.js'

const defaultMigrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface DatabaseConnection {
  readonly client: Database.Database
  readonly db: BetterSQLite3Database<typeof schema>
  close(): void
  migrate(migrationsFolder?: string): void
}

type DatabaseConfig = Pick<
  AppConfig,
  'databasePath' | 'databaseBusyTimeoutMs' | 'databaseWalAutocheckpointPages'
>

function normalizeDatabasePath(databasePath: string): string {
  if (databasePath === ':memory:') return databasePath
  return resolve(databasePath)
}

export function openDatabase(config: DatabaseConfig): DatabaseConnection {
  const databasePath = normalizeDatabasePath(config.databasePath)
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  const client = new Database(databasePath)
  client.pragma('foreign_keys = ON')
  client.pragma(`busy_timeout = ${config.databaseBusyTimeoutMs}`)

  if (databasePath !== ':memory:') {
    client.pragma('journal_mode = WAL')
    client.pragma('synchronous = NORMAL')
    client.pragma(`wal_autocheckpoint = ${config.databaseWalAutocheckpointPages}`)
  }

  const db = drizzle(client, { schema })
  return {
    client,
    db,
    close: () => client.close(),
    migrate: (migrationsFolder = defaultMigrationsFolder) => {
      migrate(db, { migrationsFolder })
    },
  }
}
