import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import type {
  EmbeddingProvider,
  VectorIndex,
  VectorPoint,
  VisionUnderstandingProvider,
} from '../src/ai/contracts.js'
import { AiIndexingHandler } from '../src/ai/indexing-handler.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  aiIndexes,
  aiIndexRecords,
  aiProjectSettings,
  aiUsageLedger,
  assets,
  assetVersions,
  organization,
  projects,
  semanticEvaluations,
  storageObjects,
  user,
} from '../src/db/schema.js'
import type { JobRecord } from '../src/repositories/types.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'

const databases: DatabaseConnection[] = []
const runtimes: StorageRuntime[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

class FakeProvider implements VisionUnderstandingProvider, EmbeddingProvider {
  readonly provider = 'fake'
  readonly model = 'embedding-snapshot'
  readonly dimensions = 3
  async describeImage() {
    return {
      caption: 'A red bicycle beside a bright storefront',
      tags: ['bicycle', 'storefront'],
      ocrText: null,
      safety: {},
      usage: { inputUnits: 20, outputUnits: 8 },
    }
  }
  async embedText({ texts }: { texts: readonly string[] }) {
    return { vectors: texts.map(() => [0.1, 0.2, 0.3]), usage: { inputUnits: 6, outputUnits: 0 } }
  }
}

class FakeVectors implements VectorIndex {
  points: VectorPoint[] = []
  ensured = false
  async ensureCollection() {
    this.ensured = true
  }
  async upsert(_collection: string, points: readonly VectorPoint[]) {
    this.points.push(...points)
  }
  async search(
    _collection: string,
    _vector: readonly number[],
    scope: { organizationId: string; projectId: string },
  ) {
    return this.points.flatMap((point) =>
      point.payload.organization_id === scope.organizationId &&
      point.payload.project_id === scope.projectId
        ? [
            {
              pointId: point.id,
              score: 1,
              assetId: String(point.payload.asset_id),
              assetVersionId: String(point.payload.asset_version_id),
            },
          ]
        : [],
    )
  }
  async deleteAsset() {}
  async deleteCollection() {}
  async health() {
    return true
  }
}

describe('AI indexing worker', () => {
  it('indexes normalized media, evaluates isolation, and atomically activates the candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeonic-ai-indexing-'))
    directories.push(directory)
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      LOCAL_STORAGE_PATH: join(directory, 'objects'),
      AI_ENABLED: 'true',
      AI_PROVIDER_API_KEY: 'test-key',
      AI_VISION_MODEL: 'vision-snapshot',
      AI_EMBEDDING_MODEL: 'embedding-snapshot',
      AI_EMBEDDING_DIMENSIONS: '3',
    })
    const database = openDatabase(config)
    databases.push(database)
    database.migrate()
    const storage = createStorageRuntime(config)
    runtimes.push(storage)
    await storage.port.initialize()
    const now = new Date()
    const userId = uuidv7()
    const organizationId = uuidv7()
    const projectId = uuidv7()
    const assetId = uuidv7()
    const versionId = uuidv7()
    const objectId = uuidv7()
    const indexId = uuidv7()
    const scope = { organizationId, projectId }
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#cc3322' },
    })
      .png()
      .toBuffer()
    const hash = createHash('sha256').update(image).digest('hex')
    const objectKey = createStorageObjectKey(scope, 'original', objectId)
    await storage.port.put(scope, objectKey, Readable.from(image), {
      maxBytes: image.byteLength,
      expectedBytes: image.byteLength,
      expectedSha256: hash,
    })
    database.db.insert(user).values({ id: userId, name: 'Owner', email: 'ai@example.com' }).run()
    database.db
      .insert(organization)
      .values({ id: organizationId, name: 'Studio', slug: 'studio', createdAt: now })
      .run()
    database.db
      .insert(projects)
      .values({
        id: projectId,
        organizationId,
        name: 'Library',
        slug: 'library',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    database.db
      .insert(storageObjects)
      .values({
        id: objectId,
        ...scope,
        backend: 'local',
        namespace: 'original',
        objectKey,
        state: 'available',
        sizeBytes: image.byteLength,
        sha256: hash,
        createdAt: now,
        updatedAt: now,
        finalizedAt: now,
      })
      .run()
    database.db
      .insert(assets)
      .values({
        id: assetId,
        ...scope,
        publicId: uuidv7(),
        name: 'Campaign bicycle',
        folder: 'summer',
        mediaKind: 'image',
        visibility: 'public',
        state: 'ready',
        currentVersion: 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    database.db
      .insert(assetVersions)
      .values({
        id: versionId,
        ...scope,
        assetId,
        version: 1,
        state: 'ready',
        storageObjectId: objectId,
        sha256: hash,
        mimeType: 'image/png',
        sizeBytes: image.byteLength,
        width: 64,
        height: 64,
        createdBy: userId,
        createdAt: now,
      })
      .run()
    database.db
      .insert(aiProjectSettings)
      .values({
        ...scope,
        enabled: true,
        allowPrivateAssets: false,
        monthlyBudgetMicroUsd: 0,
        maxAssetsPerRun: 10,
        concurrency: 1,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    database.db
      .insert(aiIndexes)
      .values({
        id: indexId,
        ...scope,
        state: 'building',
        provider: 'fake',
        visionModel: 'vision-snapshot',
        embeddingModel: 'embedding-snapshot',
        dimensions: 3,
        pipelineVersion: 'semantic-v1',
        promptVersion: 'media-caption-v1',
        collectionName: `aeonic_${indexId.replaceAll('-', '')}`,
        createdBy: userId,
        createdAt: now,
      })
      .run()
    const provider = new FakeProvider()
    const vectors = new FakeVectors()
    const handler = new AiIndexingHandler(database, storage, config, provider, provider, vectors)
    const job: JobRecord = {
      id: uuidv7(),
      ...scope,
      type: 'ai.reindex',
      state: 'running',
      payload: { indexId, maximumAssets: 10 },
      progress: 0,
      attempts: 1,
      maxAttempts: 3,
      runAfter: now,
      leaseOwner: 'test',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    const progress: number[] = []
    await handler.reindex(job, {
      signal: new AbortController().signal,
      reportProgress: (value) => progress.push(value),
    })
    assert.equal(vectors.ensured, true)
    assert.equal(vectors.points.length, 1)
    assert.deepEqual(vectors.points[0]?.payload, {
      organization_id: organizationId,
      project_id: projectId,
      asset_id: assetId,
      asset_version_id: versionId,
      content_kind: 'image',
      chunk_ordinal: 0,
      provider: 'fake',
      embedding_model: 'embedding-snapshot',
      embedding_dimensions: 3,
      pipeline_version: 'semantic-v1',
      prompt_version: 'media-caption-v1',
      generated_by: 'ai',
    })
    assert.equal(
      database.db.select().from(aiIndexes).where(eq(aiIndexes.id, indexId)).get()?.state,
      'active',
    )
    const records = database.db.select().from(aiIndexRecords).all()
    assert.equal(records.length, 1)
    assert.deepEqual(records[0]?.metadata, {
      tags: ['bicycle', 'storefront'],
      safety: {},
      generatedBy: 'ai',
      visionProvider: 'fake',
      visionModel: 'embedding-snapshot',
    })
    assert.equal(database.db.select().from(semanticEvaluations).get()?.approved, true)
    assert.equal(database.db.select().from(aiUsageLedger).all().length, 3)
    assert.equal(progress.at(-1), 100)
  })
})
