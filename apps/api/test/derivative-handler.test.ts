import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, before, describe, it } from 'node:test'
import type { CreateDerivativeRequest } from '@aeonic/contracts'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import {
  assets,
  assetVersions,
  derivatives,
  member,
  organization,
  projects,
  storageObjects,
  user,
} from '../src/db/schema.js'
import { AsyncDerivativeService } from '../src/derivatives/async-service.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobRunner } from '../src/jobs/runner.js'
import { MediaDerivativeHandler } from '../src/media/derivative-handler.js'
import { runMediaCommand } from '../src/media/subprocess.js'
import { ProjectService } from '../src/projects/service.js'
import { createStorageObjectKey, type StorageObjectKey } from '../src/storage/contracts.js'
import { createStorageRuntime } from '../src/storage/factory.js'

const cleanups: Array<() => void | Promise<void>> = []
let video: Buffer
let docx: Buffer

function pdfFixture(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 50 Td (Hello Aeonic) Tj ET\nendstream',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

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

  const directory = await mkdtemp(join(tmpdir(), 'aeonic-handler-office-'))
  try {
    const sourcePath = join(directory, 'fixture.fodt')
    await writeFile(
      sourcePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
  <office:body><office:text><text:p>Aeonic preview</text:p></office:text></office:body>
</office:document>`,
    )
    await runMediaCommand(
      'libreoffice',
      [
        `-env:UserInstallation=file://${join(directory, 'profile')}`,
        '--headless',
        '--convert-to',
        'docx',
        '--outdir',
        directory,
        sourcePath,
      ],
      {
        timeoutMs: 20_000,
        maxStdoutBytes: 100_000,
        maxStderrBytes: 100_000,
        runtimeDirectory: directory,
      },
    )
    docx = await readFile(join(directory, 'fixture.docx'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(mediaKind: 'video' | 'document', mimeType: string, content: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-derivative-handler-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOCAL_STORAGE_PATH: join(directory, 'objects'),
    IMAGE_MAX_OUTPUT_BYTES: '10485760',
    WORKER_JOB_TIMEOUT_MS: '30000',
  })
  const database = openDatabase(config)
  database.migrate()
  const storage = createStorageRuntime(config)
  await storage.port.initialize()
  cleanups.push(
    () => database.close(),
    () => storage.close(),
    () => rm(directory, { recursive: true, force: true }),
  )

  const now = new Date()
  const userId = uuidv7()
  const organizationId = uuidv7()
  const projectId = uuidv7()
  const assetId = uuidv7()
  const assetVersionId = uuidv7()
  const storageObjectId = uuidv7()
  const publicId = uuidv7()
  const scope = { organizationId, projectId }
  const sourceKey = createStorageObjectKey(scope, 'original', storageObjectId)
  const sha256 = createHash('sha256').update(content).digest('hex')
  await storage.port.put(scope, sourceKey, Readable.from(content), {
    maxBytes: content.byteLength,
    expectedBytes: content.byteLength,
    expectedSha256: sha256,
  })
  database.db
    .insert(user)
    .values({ id: userId, name: 'Owner', email: `${uuidv7()}@example.com` })
    .run()
  database.db
    .insert(organization)
    .values({ id: organizationId, name: 'Studio', slug: `studio-${uuidv7()}`, createdAt: now })
    .run()
  database.db
    .insert(member)
    .values({ id: uuidv7(), organizationId, userId, role: 'owner', createdAt: now })
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
      ...scope,
      backend: 'local',
      namespace: 'original',
      objectKey: sourceKey,
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
      ...scope,
      publicId,
      name: mediaKind,
      mediaKind,
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
      id: assetVersionId,
      ...scope,
      assetId,
      version: 1,
      state: 'ready',
      storageObjectId,
      sha256,
      mimeType,
      sizeBytes: content.byteLength,
      createdBy: userId,
      createdAt: now,
    })
    .run()

  const service = new AsyncDerivativeService(database, new ProjectService(database), storage)
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([['media.derive', new MediaDerivativeHandler(database, storage, config).handle]]),
    {
      workerId: 'worker:derivatives',
      leaseMs: 35_000,
      heartbeatMs: 1_000,
      timeoutMs: 30_000,
      pollMs: 10,
    },
  )
  return {
    database,
    storage,
    service,
    runner,
    principal: { type: 'user' as const, userId, sessionId: uuidv7() },
    scope,
    publicId,
  }
}

async function process(test: Awaited<ReturnType<typeof fixture>>, input: CreateDerivativeRequest) {
  const requested = test.service.create(
    test.principal,
    test.scope,
    test.publicId,
    1,
    input,
    uuidv7(),
  )
  assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')
  const row = test.database.db
    .select()
    .from(derivatives)
    .where(eq(derivatives.id, requested.id))
    .get()
  assert.equal(row?.state, 'ready')
  assert.ok(row?.storageObjectId)
  const stored = test.database.db
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.id, row.storageObjectId))
    .get()
  assert.equal(stored?.state, 'available')
  const bytes = await test.storage.port.open(test.scope, stored?.objectKey as StorageObjectKey)
  const chunks: Buffer[] = []
  for await (const chunk of bytes) chunks.push(Buffer.from(chunk))
  return { row, content: Buffer.concat(chunks) }
}

describe('media derivative worker', () => {
  it('creates video posters and bounded transcodes', async () => {
    const posterTest = await fixture('video', 'video/mp4', video)
    const poster = await process(posterTest, { operation: 'video_poster', width: 80 })
    assert.equal(poster.row?.mimeType, 'image/jpeg')
    assert.equal(poster.row?.width, 80)

    const transcodeTest = await fixture('video', 'video/mp4', video)
    const transcode = await process(transcodeTest, {
      operation: 'video_transcode',
      preset: 'webm-720p',
      durationSeconds: 1,
    })
    assert.equal(transcode.row?.mimeType, 'video/webm')
    assert.equal(transcode.content.subarray(0, 4).toString('hex'), '1a45dfa3')
    assert.ok((transcode.row?.durationMs ?? 0) > 0)
  })

  it('creates PDF thumbnails and searchable text', async () => {
    const thumbnailTest = await fixture('document', 'application/pdf', pdfFixture())
    const thumbnail = await process(thumbnailTest, {
      operation: 'pdf_thumbnail',
      maxDimension: 200,
    })
    assert.equal(thumbnail.row?.mimeType, 'image/png')
    assert.equal(thumbnail.row?.width, 200)

    const textTest = await fixture('document', 'application/pdf', pdfFixture())
    const text = await process(textTest, { operation: 'pdf_text' })
    assert.equal(text.row?.mimeType, 'text/plain; charset=utf-8')
    assert.match(text.content.toString('utf8'), /Hello Aeonic/)

    await textTest.service.invalidate(
      textTest.principal,
      textTest.scope,
      text.row?.id as string,
      uuidv7(),
    )
    assert.equal(
      textTest.database.db
        .select()
        .from(derivatives)
        .where(eq(derivatives.id, text.row?.id as string))
        .get(),
      undefined,
    )
    assert.equal(
      textTest.database.db
        .select()
        .from(storageObjects)
        .where(eq(storageObjects.id, text.row?.storageObjectId as string))
        .get()?.state,
      'deleted',
    )
  })

  it('creates a PDF preview for an Office document', async () => {
    const test = await fixture(
      'document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docx,
    )
    const preview = await process(test, { operation: 'office_preview' })
    assert.equal(preview.row?.mimeType, 'application/pdf')
    assert.equal(preview.content.subarray(0, 5).toString(), '%PDF-')
  })
})
