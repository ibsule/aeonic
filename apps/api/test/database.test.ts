import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { sql } from 'drizzle-orm'
import { openDatabase } from '../src/db/database.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aeonic-database-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'aeonic.db')
}

describe('database', () => {
  it('creates its directory and applies reviewed migrations', () => {
    const connection = openDatabase({
      databasePath: createDatabasePath(),
      databaseBusyTimeoutMs: 1_250,
      databaseWalAutocheckpointPages: 250,
    })

    try {
      connection.migrate()
      const table = connection.client
        .prepare("select name from sqlite_master where type = 'table' and name = 'system_settings'")
        .get() as { name: string } | undefined

      assert.equal(table?.name, 'system_settings')
      assert.equal(connection.client.pragma('journal_mode', { simple: true }), 'wal')
      assert.equal(connection.client.pragma('foreign_keys', { simple: true }), 1)
      assert.equal(connection.client.pragma('busy_timeout', { simple: true }), 1_250)
      assert.equal(connection.client.pragma('wal_autocheckpoint', { simple: true }), 250)
    } finally {
      connection.close()
    }
  })

  it('can apply the same migrations repeatedly', () => {
    const connection = openDatabase({
      databasePath: createDatabasePath(),
      databaseBusyTimeoutMs: 5_000,
      databaseWalAutocheckpointPages: 1_000,
    })

    try {
      connection.migrate()
      connection.migrate()
      const result = connection.db.get<{ value: number }>(sql`select 1 as value`)
      assert.equal(result?.value, 1)
    } finally {
      connection.close()
    }
  })
})
