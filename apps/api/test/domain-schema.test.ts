import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  assets,
  jobs,
  organization,
  projects,
  storageObjects,
  uploads,
  user,
} from '../src/db/schema.js'

const databases: DatabaseConnection[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase(): DatabaseConnection {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' })
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  return database
}

function seedTenants(database: DatabaseConnection) {
  const now = new Date()
  const userId = uuidv7()
  const firstOrganizationId = uuidv7()
  const secondOrganizationId = uuidv7()
  const firstProjectId = uuidv7()
  const secondProjectId = uuidv7()
  database.db.insert(user).values({ id: userId, name: 'Owner', email: 'schema@example.com' }).run()
  database.db
    .insert(organization)
    .values([
      { id: firstOrganizationId, name: 'First', slug: 'first', createdAt: now },
      { id: secondOrganizationId, name: 'Second', slug: 'second', createdAt: now },
    ])
    .run()
  database.db
    .insert(projects)
    .values([
      {
        id: firstProjectId,
        organizationId: firstOrganizationId,
        name: 'First',
        slug: 'first',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondProjectId,
        organizationId: secondOrganizationId,
        name: 'Second',
        slug: 'second',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run()
  return { now, userId, firstOrganizationId, firstProjectId, secondProjectId }
}

describe('Phase 2 domain schema', () => {
  it('enforces project and organization tenant consistency', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    assert.throws(
      () =>
        database.db
          .insert(assets)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.secondProjectId,
            publicId: 'cross-tenant',
            name: 'Cross tenant',
            mediaKind: 'image',
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    )
  })

  it('enforces durable job progress and retry invariants', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    assert.throws(
      () =>
        database.db
          .insert(jobs)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            type: 'asset.inspect',
            payload: {},
            progress: 101,
            runAfter: tenant.now,
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: jobs_progress_range/,
    )
  })
})

describe('Phase 3 storage schema', () => {
  it('enforces storage object tenant consistency and lifecycle metadata', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)

    assert.throws(
      () =>
        database.db
          .insert(storageObjects)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.secondProjectId,
            backend: 'local',
            namespace: 'original',
            objectKey: `original/${uuidv7()}`,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    )

    assert.throws(
      () =>
        database.db
          .insert(storageObjects)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            backend: 'local',
            namespace: 'original',
            objectKey: `original/${uuidv7()}`,
            state: 'available',
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: storage_objects_available_metadata/,
    )
  })

  it('enforces upload byte and checksum invariants', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)

    assert.throws(
      () =>
        database.db
          .insert(uploads)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            protocol: 'simple',
            expectedBytes: 10,
            receivedBytes: 11,
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: uploads_received_within_expected/,
    )

    assert.throws(
      () =>
        database.db
          .insert(uploads)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            protocol: 'simple',
            checksumAlgorithm: 'sha256',
            expectedChecksum: 'not-a-digest',
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: uploads_expected_checksum_valid/,
    )
  })
})
