import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  agentPlans,
  agentRuns,
  approvalRequests,
  assets,
  assetVersions,
  derivatives,
  jobs,
  organization,
  projects,
  storageObjects,
  transformPresets,
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

    assert.throws(
      () =>
        database.db
          .insert(jobs)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            type: 'asset.inspect',
            state: 'running',
            payload: {},
            runAfter: tenant.now,
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: jobs_lease_consistent/,
    )

    assert.throws(
      () =>
        database.db
          .insert(jobs)
          .values({
            id: uuidv7(),
            organizationId: tenant.firstOrganizationId,
            projectId: tenant.firstProjectId,
            type: 'asset.inspect',
            state: 'succeeded',
            payload: {},
            progress: 99,
            runAfter: tenant.now,
            completedAt: tenant.now,
            createdBy: tenant.userId,
            createdAt: tenant.now,
            updatedAt: tenant.now,
          })
          .run(),
      /CHECK constraint failed: jobs_success_progress_complete/,
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

describe('Phase 4 transform preset schema', () => {
  it('keeps immutable preset versions tenant-scoped and uniquely addressable', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    const preset = {
      id: uuidv7(),
      organizationId: tenant.firstOrganizationId,
      projectId: tenant.firstProjectId,
      name: 'product-card',
      version: 1,
      grammarVersion: 1,
      canonicalSpec: 'w_800,h_600,f_webp',
      definition: {
        grammarVersion: 1 as const,
        autoOrient: true as const,
        width: 800,
        height: 600,
        fit: 'cover' as const,
        gravity: 'center' as const,
        format: 'webp' as const,
        quality: 80,
      },
      createdBy: tenant.userId,
      createdAt: tenant.now,
    }
    database.db.insert(transformPresets).values(preset).run()

    assert.throws(
      () =>
        database.db
          .insert(transformPresets)
          .values({ ...preset, id: uuidv7() })
          .run(),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () =>
        database.db
          .insert(transformPresets)
          .values({ ...preset, id: uuidv7(), projectId: tenant.secondProjectId })
          .run(),
      /FOREIGN KEY constraint failed/,
    )
  })

  it('rejects malformed names and unsupported grammar versions', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    const preset = {
      id: uuidv7(),
      organizationId: tenant.firstOrganizationId,
      projectId: tenant.firstProjectId,
      name: 'hero--latest',
      version: 1,
      grammarVersion: 1,
      canonicalSpec: 'w_1200',
      definition: {
        grammarVersion: 1 as const,
        autoOrient: true as const,
        width: 1200,
        fit: 'cover' as const,
        gravity: 'center' as const,
        format: 'source' as const,
        quality: 80,
      },
      createdBy: tenant.userId,
      createdAt: tenant.now,
    }

    assert.throws(
      () => database.db.insert(transformPresets).values(preset).run(),
      /CHECK constraint failed: transform_presets_name_valid/,
    )
    assert.throws(
      () =>
        database.db
          .insert(transformPresets)
          .values({ ...preset, id: uuidv7(), name: 'hero', grammarVersion: 2 })
          .run(),
      /CHECK constraint failed: transform_presets_grammar_v1/,
    )
  })
})

describe('Phase 4 derivative cache schema', () => {
  it('enforces tenant-scoped single-flight cache identities', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    const assetId = uuidv7()
    const assetVersionId = uuidv7()
    database.db
      .insert(assets)
      .values({
        id: assetId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        publicId: uuidv7(),
        name: 'Source image',
        mediaKind: 'image',
        state: 'ready',
        currentVersion: 1,
        createdBy: tenant.userId,
        createdAt: tenant.now,
        updatedAt: tenant.now,
      })
      .run()
    database.db
      .insert(assetVersions)
      .values({
        id: assetVersionId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        assetId,
        version: 1,
        state: 'ready',
        sha256: '1'.repeat(64),
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        createdBy: tenant.userId,
        createdAt: tenant.now,
      })
      .run()

    const derivative = {
      id: uuidv7(),
      organizationId: tenant.firstOrganizationId,
      projectId: tenant.firstProjectId,
      assetVersionId,
      cacheKey: '2'.repeat(64),
      grammarVersion: 1,
      canonicalSpec: 'w_800,f_webp',
      outputFormat: 'webp' as const,
      processorFingerprint: 'sharp@0.35.4/libvips@8.18.6',
      createdBy: tenant.userId,
      createdAt: tenant.now,
      updatedAt: tenant.now,
    }
    database.db.insert(derivatives).values(derivative).run()

    assert.throws(
      () =>
        database.db
          .insert(derivatives)
          .values({ ...derivative, id: uuidv7() })
          .run(),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () =>
        database.db
          .insert(derivatives)
          .values({
            ...derivative,
            id: uuidv7(),
            cacheKey: '3'.repeat(64),
            projectId: tenant.secondProjectId,
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    )
  })

  it('requires leases while generating and complete metadata when ready', () => {
    const database = createDatabase()
    const tenant = seedTenants(database)
    const assetId = uuidv7()
    const assetVersionId = uuidv7()
    database.db
      .insert(assets)
      .values({
        id: assetId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        publicId: uuidv7(),
        name: 'Source image',
        mediaKind: 'image',
        createdBy: tenant.userId,
        createdAt: tenant.now,
        updatedAt: tenant.now,
      })
      .run()
    database.db
      .insert(assetVersions)
      .values({
        id: assetVersionId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        assetId,
        version: 1,
        createdBy: tenant.userId,
        createdAt: tenant.now,
      })
      .run()
    const derivative = {
      id: uuidv7(),
      organizationId: tenant.firstOrganizationId,
      projectId: tenant.firstProjectId,
      assetVersionId,
      cacheKey: '4'.repeat(64),
      grammarVersion: 1,
      canonicalSpec: 'w_400,f_avif',
      outputFormat: 'avif' as const,
      processorFingerprint: 'sharp@0.35.4/libvips@8.18.6',
      createdAt: tenant.now,
      updatedAt: tenant.now,
    }

    assert.throws(
      () =>
        database.db
          .insert(derivatives)
          .values({ ...derivative, state: 'generating' })
          .run(),
      /CHECK constraint failed: derivatives_lease_consistent/,
    )
    assert.throws(
      () =>
        database.db
          .insert(derivatives)
          .values({ ...derivative, id: uuidv7(), cacheKey: '5'.repeat(64), state: 'ready' })
          .run(),
      /CHECK constraint failed: derivatives_ready_metadata/,
    )
  })
})

describe('Phase 7 agent approval schema', () => {
  function seedRunAndPlan(database: DatabaseConnection) {
    const tenant = seedTenants(database)
    const runId = uuidv7()
    const planId = uuidv7()
    const planHash = 'a'.repeat(64)
    const expiresAt = new Date(tenant.now.getTime() + 15 * 60_000)
    const budget = {
      maxSteps: 10,
      maxWallTimeMs: 60_000,
      maxTokens: 10_000,
      maxCostMicroUsd: 100_000,
      maxAssets: 100,
      maxOutputBytes: 10_000_000,
      maxRetries: 2,
    }
    database.db
      .insert(agentRuns)
      .values({
        id: runId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        request: 'Find assets that need descriptions.',
        budget,
        createdBy: tenant.userId,
        createdAt: tenant.now,
        updatedAt: tenant.now,
      })
      .run()
    database.db
      .insert(agentPlans)
      .values({
        id: planId,
        organizationId: tenant.firstOrganizationId,
        projectId: tenant.firstProjectId,
        runId,
        planHash,
        plannerVersion: 'planner-v1',
        summary: 'Add descriptions to one asset.',
        riskClass: 'standard',
        reversibility: 'reversible',
        requiredRole: 'admin',
        toolCalls: [
          {
            id: 'call-1',
            tool: 'assets.update_metadata',
            arguments: {},
            expectedEffect: 'Update one asset.',
            targetIds: [],
          },
        ],
        targetSnapshot: [],
        budget,
        expiresAt,
        createdAt: tenant.now,
      })
      .run()
    return { ...tenant, runId, planId, planHash, expiresAt }
  }

  it('freezes plan content and its approval hash', () => {
    const database = createDatabase()
    const seeded = seedRunAndPlan(database)

    assert.throws(
      () =>
        database.client
          .prepare('update agent_plans set summary = ? where id = ?')
          .run('Changed after review', seeded.planId),
      /agent plans are immutable/,
    )
    assert.throws(
      () =>
        database.db
          .insert(approvalRequests)
          .values({
            id: uuidv7(),
            organizationId: seeded.firstOrganizationId,
            projectId: seeded.firstProjectId,
            planId: seeded.planId,
            planHash: 'b'.repeat(64),
            requestedBy: seeded.userId,
            expiresAt: seeded.expiresAt,
            createdAt: seeded.now,
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    )
  })

  it('enforces tenant scope and complete approval decisions', () => {
    const database = createDatabase()
    const seeded = seedRunAndPlan(database)

    assert.throws(
      () =>
        database.db
          .insert(agentPlans)
          .values({
            id: uuidv7(),
            organizationId: seeded.firstOrganizationId,
            projectId: seeded.secondProjectId,
            runId: seeded.runId,
            planHash: 'c'.repeat(64),
            plannerVersion: 'planner-v1',
            summary: 'Cross-tenant plan.',
            riskClass: 'standard',
            reversibility: 'reversible',
            requiredRole: 'admin',
            toolCalls: [],
            targetSnapshot: [],
            budget: {
              maxSteps: 1,
              maxWallTimeMs: 1_000,
              maxTokens: 0,
              maxCostMicroUsd: 0,
              maxAssets: 1,
              maxOutputBytes: 0,
              maxRetries: 0,
            },
            expiresAt: seeded.expiresAt,
            createdAt: seeded.now,
          })
          .run(),
      /FOREIGN KEY constraint failed/,
    )
    assert.throws(
      () =>
        database.db
          .insert(approvalRequests)
          .values({
            id: uuidv7(),
            organizationId: seeded.firstOrganizationId,
            projectId: seeded.firstProjectId,
            planId: seeded.planId,
            planHash: seeded.planHash,
            state: 'approved',
            requestedBy: seeded.userId,
            expiresAt: seeded.expiresAt,
            createdAt: seeded.now,
          })
          .run(),
      /CHECK constraint failed: approval_requests_decision_consistent/,
    )
  })
})
