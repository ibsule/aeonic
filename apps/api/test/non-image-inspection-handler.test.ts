import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, before, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  jobs,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobRunner } from '../src/jobs/runner.js'
import { NonImageInspectionHandler } from '../src/media/non-image-inspection-handler.js'
import { runMediaCommand } from '../src/media/subprocess.js'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'

const databases: DatabaseConnection[] = []
const runtimes: StorageRuntime[] = []
const directories: string[] = []
let video: Buffer

before(async () => {
  video = (
    await runMediaCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=64x48:rate=10:color=blue',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { timeoutMs: 10_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 100_000 },
    )
  ).stdout
})

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function pdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

async function fixture(kind: 'video' | 'document', mimeType: string, content: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-non-image-handler-'))
  directories.push(directory)
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOCAL_STORAGE_PATH: join(directory, 'objects'),
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
  const assetVersionId = uuidv7()
  const storageObjectId = uuidv7()
  const jobId = uuidv7()
  const scope = { organizationId, projectId }
  const storageKey = createStorageObjectKey(scope, 'original', uuidv7())
  const sha256 = createHash('sha256').update(content).digest('hex')
  await storage.port.put(scope, storageKey, Readable.from(content), {
    maxBytes: content.byteLength,
    expectedBytes: content.byteLength,
    expectedSha256: sha256,
  })
  database.db
    .insert(user)
    .values({ id: userId, name: 'Owner', email: `${kind}@example.com` })
    .run()
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
      id: storageObjectId,
      organizationId,
      projectId,
      backend: 'local',
      namespace: 'original',
      objectKey: storageKey,
      state: 'available',
      sizeBytes: content.byteLength,
      sha256,
      finalizedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assets)
    .values({
      id: assetId,
      organizationId,
      projectId,
      publicId: uuidv7(),
      name: kind,
      mediaKind: kind,
      state: 'processing',
      currentVersion: 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  database.db
    .insert(assetVersions)
    .values({
      id: assetVersionId,
      organizationId,
      projectId,
      assetId,
      version: 1,
      state: 'processing',
      storageObjectId,
      sha256,
      mimeType,
      sizeBytes: content.byteLength,
      createdBy: userId,
      createdAt: now,
    })
    .run()
  database.db
    .insert(jobs)
    .values({
      id: jobId,
      organizationId,
      projectId,
      type: `media.inspect.${kind}`,
      payload: { assetId, assetVersionId, storageObjectId },
      runAfter: now,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const mediaLimits = {
    video: {
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxDurationSeconds: 10,
      maxWidth: 1920,
      maxHeight: 1080,
      timeoutMs: 10_000,
    },
    document: {
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxPages: 10,
      maxPagePoints: 2_000,
      maxTextBytes: 100_000,
      timeoutMs: 10_000,
    },
  }
  const handler = new NonImageInspectionHandler(kind, database, storage, mediaLimits)
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([[`media.inspect.${kind}`, handler.handle]]),
    { workerId: `worker:${kind}`, leaseMs: 2_000, heartbeatMs: 200, timeoutMs: 10_000, pollMs: 10 },
  )
  return { database, runner, assetVersionId }
}

describe('non-image inspection handlers', () => {
  it('publishes normalized video metadata', async () => {
    const test = await fixture('video', 'video/mp4', video)
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')
    const row = test.database.client
      .prepare('select state, width, height, duration_ms from asset_versions where id = ?')
      .get(test.assetVersionId)
    assert.deepEqual(row, { state: 'ready', width: 64, height: 48, duration_ms: 1000 })
  })

  it('publishes normalized PDF metadata', async () => {
    const test = await fixture('document', 'application/pdf', pdf())
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')
    const row = test.database.client
      .prepare('select state, width, height from asset_versions where id = ?')
      .get(test.assetVersionId)
    assert.deepEqual(row, { state: 'ready', width: 200, height: 100 })
  })
})
