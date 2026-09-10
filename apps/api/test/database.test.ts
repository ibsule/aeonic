import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { openDatabase } from '../src/db/database.js'
import {
  apikey,
  member,
  organization,
  projectApiKeys,
  projectMembers,
  projects,
  user,
} from '../src/db/schema.js'

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

interface MigrationJournal {
  version: string
  dialect: string
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>
}

function migrationSubset(lastIndex: number): string {
  const source = new URL('../drizzle/', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'aeonic-migrations-'))
  temporaryDirectories.push(directory)
  const metadataDirectory = join(directory, 'meta')
  mkdirSync(metadataDirectory)

  const journal = JSON.parse(
    readFileSync(new URL('meta/_journal.json', source), 'utf8'),
  ) as MigrationJournal
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex)
  writeFileSync(
    join(metadataDirectory, '_journal.json'),
    JSON.stringify({ ...journal, entries }),
    'utf8',
  )
  for (const entry of entries) {
    copyFileSync(new URL(`${entry.tag}.sql`, source), join(directory, `${entry.tag}.sql`))
  }
  return directory
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

  it('upgrades a populated Phase 2 control-plane database without losing tenant data', () => {
    const connection = openDatabase({
      databasePath: createDatabasePath(),
      databaseBusyTimeoutMs: 5_000,
      databaseWalAutocheckpointPages: 1_000,
    })

    try {
      connection.migrate(migrationSubset(4))
      const now = new Date()
      const userId = uuidv7()
      const organizationId = uuidv7()
      const projectId = uuidv7()
      const keyId = uuidv7()
      connection.db.transaction((transaction) => {
        transaction
          .insert(user)
          .values({ id: userId, name: 'Upgrade Owner', email: 'upgrade@example.com' })
          .run()
        transaction
          .insert(organization)
          .values({
            id: organizationId,
            name: 'Upgrade Studio',
            slug: 'upgrade-studio',
            createdAt: now,
          })
          .run()
        transaction
          .insert(member)
          .values({ id: uuidv7(), organizationId, userId, role: 'owner', createdAt: now })
          .run()
        transaction
          .insert(projects)
          .values({
            id: projectId,
            organizationId,
            name: 'Upgrade Library',
            slug: 'upgrade-library',
            createdBy: userId,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(projectMembers)
          .values({
            id: uuidv7(),
            organizationId,
            projectId,
            userId,
            createdBy: userId,
            createdAt: now,
          })
          .run()
        transaction
          .insert(apikey)
          .values({
            id: keyId,
            referenceId: organizationId,
            key: 'stored-hash',
            name: 'Upgrade key',
            createdAt: now,
            updatedAt: now,
          })
          .run()
        transaction
          .insert(projectApiKeys)
          .values({ keyId, organizationId, projectId, createdBy: userId, createdAt: now })
          .run()
      })

      connection.migrate()

      const preservedMember = connection.client
        .prepare('select user_id from project_members where project_id = ?')
        .pluck()
        .get(projectId)
      const preservedKey = connection.client
        .prepare('select key_id from project_api_keys where project_id = ?')
        .pluck()
        .get(projectId)
      const assetsTable = connection.client
        .prepare("select name from sqlite_master where type = 'table' and name = 'assets'")
        .pluck()
        .get()
      const foreignKeyErrors = connection.client.pragma('foreign_key_check')

      assert.equal(preservedMember, userId)
      assert.equal(preservedKey, keyId)
      assert.equal(assetsTable, 'assets')
      assert.deepEqual(foreignKeyErrors, [])
    } finally {
      connection.close()
    }
  })

  it('upgrades Phase 2 media records into the explicit upload lifecycle', () => {
    const connection = openDatabase({
      databasePath: createDatabasePath(),
      databaseBusyTimeoutMs: 5_000,
      databaseWalAutocheckpointPages: 1_000,
    })

    try {
      connection.migrate(migrationSubset(5))
      const now = new Date()
      const userId = uuidv7()
      const organizationId = uuidv7()
      const projectId = uuidv7()
      const assetId = uuidv7()
      connection.db
        .insert(user)
        .values({ id: userId, name: 'Owner', email: 'media@example.com' })
        .run()
      connection.db
        .insert(organization)
        .values({ id: organizationId, name: 'Studio', slug: 'media-studio', createdAt: now })
        .run()
      connection.db
        .insert(projects)
        .values({
          id: projectId,
          organizationId,
          name: 'Library',
          slug: 'media-library',
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      connection.client
        .prepare(
          `insert into assets
            (id, organization_id, project_id, public_id, name, media_kind, state, created_by, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          assetId,
          organizationId,
          projectId,
          'legacy-image',
          'Legacy image',
          'image',
          userId,
          now.getTime(),
          now.getTime(),
        )
      connection.client
        .prepare(
          `insert into asset_versions
            (id, organization_id, project_id, asset_id, version, state, storage_key, created_by, created_at)
           values (?, ?, ?, ?, 1, 'pending', null, ?, ?)`,
        )
        .run(uuidv7(), organizationId, projectId, assetId, userId, now.getTime())

      connection.migrate()

      const assetState = connection.client
        .prepare('select state from assets where id = ?')
        .pluck()
        .get(assetId)
      const version = connection.client
        .prepare('select state, storage_object_id from asset_versions where asset_id = ?')
        .get(assetId) as { state: string; storage_object_id: string | null }
      const storageTable = connection.client
        .prepare("select name from sqlite_master where type = 'table' and name = 'storage_objects'")
        .pluck()
        .get()

      assert.equal(assetState, 'uploading')
      assert.deepEqual(version, { state: 'uploading', storage_object_id: null })
      assert.equal(storageTable, 'storage_objects')
      assert.deepEqual(connection.client.pragma('foreign_key_check'), [])
    } finally {
      connection.close()
    }
  })

  it('refuses to discard legacy storage keys during migration', () => {
    const connection = openDatabase({
      databasePath: createDatabasePath(),
      databaseBusyTimeoutMs: 5_000,
      databaseWalAutocheckpointPages: 1_000,
    })

    try {
      connection.migrate(migrationSubset(5))
      const now = new Date()
      const userId = uuidv7()
      const organizationId = uuidv7()
      const projectId = uuidv7()
      const assetId = uuidv7()
      connection.db
        .insert(user)
        .values({ id: userId, name: 'Owner', email: 'guard@example.com' })
        .run()
      connection.db
        .insert(organization)
        .values({ id: organizationId, name: 'Guard', slug: 'guard', createdAt: now })
        .run()
      connection.db
        .insert(projects)
        .values({
          id: projectId,
          organizationId,
          name: 'Guard',
          slug: 'guard',
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      connection.client
        .prepare(
          `insert into assets
            (id, organization_id, project_id, public_id, name, media_kind, created_by, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assetId,
          organizationId,
          projectId,
          'guarded-image',
          'Guarded image',
          'image',
          userId,
          now.getTime(),
          now.getTime(),
        )
      connection.client
        .prepare(
          `insert into asset_versions
            (id, organization_id, project_id, asset_id, version, storage_key, created_by, created_at)
           values (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          uuidv7(),
          organizationId,
          projectId,
          assetId,
          'legacy/path/image.jpg',
          userId,
          now.getTime(),
        )

      assert.throws(() => connection.migrate(), /__asset_versions_storage_key_guard/)
    } finally {
      connection.close()
    }
  })
})
