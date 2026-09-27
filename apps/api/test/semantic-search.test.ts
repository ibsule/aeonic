import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { sql } from 'drizzle-orm'
import request from 'supertest'
import { v7 as uuidv7 } from 'uuid'
import type { EmbeddingProvider, VectorIndex, VectorPoint } from '../src/ai/contracts.js'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  aiIndexRecords,
  aiIndexes,
  aiUsageLedger,
  assets,
  assetVersions,
  jobs,
} from '../src/db/schema.js'

const databases: DatabaseConnection[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

class FakeEmbeddings implements EmbeddingProvider {
  readonly provider = 'fake'
  readonly model = 'embedding-snapshot'
  readonly dimensions = 3
  fail = false

  async embedText({ texts }: { texts: readonly string[] }) {
    if (this.fail) throw new Error('provider detail must not escape')
    return {
      vectors: texts.map(() => [0.1, 0.2, 0.3]),
      usage: { inputUnits: 12, outputUnits: 0 },
    }
  }
}

class FakeVectors implements VectorIndex {
  hits: Array<{ pointId: string; score: number; assetId: string; assetVersionId: string }> = []
  searches: Array<{ organizationId: string; projectId: string }> = []

  async ensureCollection(): Promise<void> {}
  async upsert(_collection: string, _points: readonly VectorPoint[]): Promise<void> {}
  async search(
    _collection: string,
    _vector: readonly number[],
    scope: { organizationId: string; projectId: string },
  ) {
    this.searches.push(scope)
    return this.hits
  }
  async deleteAsset(): Promise<void> {}
  async deleteCollection(): Promise<void> {}
  async health(): Promise<boolean> {
    return true
  }
}

async function fixture(options: { ai?: boolean } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: 'http://localhost:3001',
    ...(options.ai
      ? {
          AI_ENABLED: 'true',
          AI_PROVIDER_API_KEY: 'test-provider-key',
          AI_VISION_MODEL: 'vision-snapshot',
          AI_EMBEDDING_MODEL: 'embedding-snapshot',
          AI_EMBEDDING_DIMENSIONS: '3',
          AI_INPUT_MICRO_USD_PER_MILLION_UNITS: '1000000',
        }
      : {}),
  })
  const database = openDatabase(config)
  databases.push(database)
  database.migrate()
  const auth = createAuth(config, database)
  const embeddings = new FakeEmbeddings()
  const vectors = new FakeVectors()
  const app = buildApp({
    config,
    auth,
    database,
    logger: false,
    ...(options.ai ? { aiEmbeddings: embeddings, vectorIndex: vectors } : {}),
  })
  const setup = await request(app)
    .post('/api/v1/setup')
    .send({
      name: 'Owner',
      email: 'owner@example.com',
      password: 'a-strong-development-password',
      organizationName: 'Studio',
      organizationSlug: 'studio',
      projectName: 'Library',
      projectSlug: 'library',
    })
    .expect(201)
  const agent = request.agent(app)
  await agent
    .post('/api/auth/sign-in/email')
    .send({ email: 'owner@example.com', password: 'a-strong-development-password' })
    .expect(200)
  return {
    agent,
    database,
    config,
    embeddings,
    vectors,
    organizationId: setup.body.organizationId as string,
    projectId: setup.body.projectId as string,
    userId: setup.body.userId as string,
  }
}

function addAsset(
  database: DatabaseConnection,
  input: { organizationId: string; projectId: string; userId: string; name: string },
) {
  const now = new Date()
  const assetId = uuidv7()
  const publicId = uuidv7()
  const versionId = uuidv7()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      publicId,
      name: input.name,
      folder: 'campaigns/summer',
      mediaKind: 'image',
      visibility: 'private',
      state: 'ready',
      currentVersion: 1,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assetVersions)
    .values({
      id: versionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      assetId,
      version: 1,
      state: 'ready',
      mimeType: 'image/jpeg',
      sizeBytes: 2_048,
      sha256: 'a'.repeat(64),
      width: 1_200,
      height: 630,
      metadata: { camera: 'Aeonic 1', subject: 'red bicycle' },
      createdBy: input.userId,
      createdAt: now,
    })
    .run()
  return { assetId, publicId, versionId }
}

describe('semantic search API', () => {
  it('provides FTS5 lexical search when AI is entirely disabled', async () => {
    const { agent, database, organizationId, projectId, userId } = await fixture()
    addAsset(database, { organizationId, projectId, userId, name: 'Campaign hero' })
    const base = `/api/v1/organizations/${organizationId}/projects/${projectId}`

    const settings = await agent.get(`${base}/semantic/settings`)
    assert.equal(settings.status, 200, JSON.stringify(settings.body))
    assert.equal(settings.body.deploymentEnabled, false)
    assert.equal(settings.body.enabled, false)
    const search = await agent.get(`${base}/search`).query({ query: 'red bicycle' })
    assert.equal(search.status, 200, JSON.stringify(search.body))
    assert.equal(search.body.mode, 'lexical')
    assert.equal(search.body.degradedReason, null)
    assert.equal(search.body.items.length, 1)
    assert.equal(search.body.items[0].asset.name, 'Campaign hero')
    assert.ok(search.body.items[0].reasons.includes('metadata'))
    await agent.patch(`${base}/semantic/settings`).send({ enabled: true }).expect(409)
  })

  it('fuses vector results only after authoritative SQLite revalidation', async () => {
    const { agent, database, organizationId, projectId, userId, vectors } = await fixture({
      ai: true,
    })
    const asset = addAsset(database, {
      organizationId,
      projectId,
      userId,
      name: 'Campaign hero',
    })
    const indexId = uuidv7()
    const now = new Date()
    database.db
      .insert(aiIndexes)
      .values({
        id: indexId,
        organizationId,
        projectId,
        state: 'active',
        provider: 'openai',
        visionModel: 'vision-snapshot',
        embeddingModel: 'embedding-snapshot',
        dimensions: 3,
        pipelineVersion: 'semantic-v1',
        promptVersion: 'caption-v1',
        collectionName: `aeonic_${indexId.replaceAll('-', '')}`,
        indexedAssets: 1,
        createdBy: userId,
        createdAt: now,
        evaluatedAt: now,
        activatedAt: now,
      })
      .run()
    database.db
      .insert(aiIndexRecords)
      .values({
        id: uuidv7(),
        organizationId,
        projectId,
        indexId,
        assetId: asset.assetId,
        assetVersionId: asset.versionId,
        pointId: uuidv7(),
        contentKind: 'image',
        chunkOrdinal: 0,
        caption: 'A bright red bicycle outside a shop.',
        provider: 'openai',
        model: 'embedding-snapshot',
        dimensions: 3,
        promptVersion: 'caption-v1',
        createdAt: now,
      })
      .run()
    vectors.hits = [
      { pointId: uuidv7(), score: 0.99, assetId: uuidv7(), assetVersionId: uuidv7() },
      { pointId: uuidv7(), score: 0.9, assetId: asset.assetId, assetVersionId: asset.versionId },
    ]
    const base = `/api/v1/organizations/${organizationId}/projects/${projectId}`
    const settings = await agent
      .patch(`${base}/semantic/settings`)
      .send({ enabled: true, allowPrivateAssets: true, monthlyBudgetMicroUsd: 10_000 })
    assert.equal(settings.status, 200, JSON.stringify(settings.body))

    const result = await agent.get(`${base}/search`).query({ query: 'transport outdoors' })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.mode, 'hybrid')
    assert.equal(result.body.items.length, 1)
    assert.equal(result.body.items[0].asset.id, asset.assetId)
    assert.ok(result.body.items[0].reasons.includes('semantic_similarity'))
    assert.deepEqual(vectors.searches, [{ organizationId, projectId }])
    assert.equal(database.db.select().from(aiUsageLedger).all().length, 1)
  })

  it('degrades to lexical search and removes excluded vector data asynchronously', async () => {
    const { agent, database, organizationId, projectId, userId, embeddings } = await fixture({
      ai: true,
    })
    const asset = addAsset(database, { organizationId, projectId, userId, name: 'Red bicycle' })
    const indexId = uuidv7()
    const now = new Date()
    database.db
      .insert(aiIndexes)
      .values({
        id: indexId,
        organizationId,
        projectId,
        state: 'active',
        provider: 'openai',
        visionModel: 'vision-snapshot',
        embeddingModel: 'embedding-snapshot',
        dimensions: 3,
        pipelineVersion: 'semantic-v1',
        promptVersion: 'caption-v1',
        collectionName: `aeonic_${indexId.replaceAll('-', '')}`,
        indexedAssets: 1,
        createdBy: userId,
        createdAt: now,
        activatedAt: now,
      })
      .run()
    database.db
      .insert(aiIndexRecords)
      .values({
        id: uuidv7(),
        organizationId,
        projectId,
        indexId,
        assetId: asset.assetId,
        assetVersionId: asset.versionId,
        pointId: uuidv7(),
        contentKind: 'image',
        chunkOrdinal: 0,
        caption: 'Red bicycle',
        provider: 'openai',
        model: 'embedding-snapshot',
        dimensions: 3,
        promptVersion: 'caption-v1',
        createdAt: now,
      })
      .run()
    const base = `/api/v1/organizations/${organizationId}/projects/${projectId}`
    const settings = await agent
      .patch(`${base}/semantic/settings`)
      .send({ enabled: true, allowPrivateAssets: true, monthlyBudgetMicroUsd: 10_000 })
    assert.equal(settings.status, 200, JSON.stringify(settings.body))
    embeddings.fail = true
    const result = await agent.get(`${base}/search`).query({ query: 'bicycle' })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.mode, 'lexical')
    assert.equal(result.body.degradedReason, 'semantic_dependency_unavailable')
    assert.equal(result.body.items.length, 1)

    await agent
      .put(`${base}/assets/${asset.publicId}/ai-exclusion`)
      .send({ excluded: true })
      .expect(204)
    assert.equal(database.db.select().from(aiIndexRecords).all().length, 0)
    assert.equal(
      database.db.select().from(jobs).where(sql`${jobs.type} = 'ai.delete_asset'`).all().length,
      1,
    )
  })
})
