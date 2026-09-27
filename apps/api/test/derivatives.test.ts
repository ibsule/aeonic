import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, before, describe, it } from 'node:test'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { SqliteJobRepository } from '../src/jobs/repository.js'
import { JobRunner } from '../src/jobs/runner.js'
import { MediaDerivativeHandler } from '../src/media/derivative-handler.js'
import { NonImageInspectionHandler } from '../src/media/non-image-inspection-handler.js'
import { runMediaCommand } from '../src/media/subprocess.js'
import { createStorageRuntime } from '../src/storage/factory.js'

const cleanups: Array<() => void | Promise<void>> = []
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
        'color=size=64x48:rate=10:color=green',
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-derivative-api-'))
  const config = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
      WORKER_JOB_TIMEOUT_MS: '30000',
      IMAGE_MAX_OUTPUT_BYTES: '10485760',
    }),
    localStoragePath: join(directory, 'objects'),
    tusStoragePath: join(directory, 'tus'),
  }
  const database = openDatabase(config)
  database.migrate()
  const storage = createStorageRuntime(config)
  await storage.port.initialize()
  const auth = createAuth(config, database)
  const app = buildApp({ config, database, storage, auth, logger: false })
  cleanups.push(
    () => rm(directory, { recursive: true, force: true }),
    () => storage.close(),
    () => database.close(),
  )
  const setup = await request(app).post('/api/v1/setup').send({
    name: 'Project Owner',
    email: 'owner@example.com',
    password: 'a-strong-development-password',
    organizationName: 'Example Studio',
    organizationSlug: 'example-studio',
    projectName: 'Media Library',
    projectSlug: 'media-library',
  })
  const agent = request.agent(app)
  await agent.post('/api/auth/sign-in/email').send({
    email: 'owner@example.com',
    password: 'a-strong-development-password',
  })
  const root = `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}`
  const mediaLimits = {
    video: {
      maxInputBytes: config.uploadMaxBytes,
      maxOutputBytes: config.imageMaxOutputBytes,
      maxDurationSeconds: config.videoMaxDurationSeconds,
      maxWidth: config.videoMaxWidth,
      maxHeight: config.videoMaxHeight,
      timeoutMs: config.workerJobTimeoutMs,
    },
    document: {
      maxInputBytes: config.uploadMaxBytes,
      maxOutputBytes: config.imageMaxOutputBytes,
      maxPages: config.documentMaxPages,
      maxPagePoints: config.documentMaxPagePoints,
      maxTextBytes: config.documentMaxTextBytes,
      timeoutMs: config.workerJobTimeoutMs,
    },
  }
  const inspection = new NonImageInspectionHandler('video', database, storage, mediaLimits)
  const derivatives = new MediaDerivativeHandler(database, storage, config)
  const runner = new JobRunner(
    new SqliteJobRepository(database),
    new Map([
      ['media.inspect.video', inspection.handle],
      ['media.derive', derivatives.handle],
    ]),
    {
      workerId: 'worker:http-test',
      leaseMs: 35_000,
      heartbeatMs: 1_000,
      timeoutMs: 30_000,
      pollMs: 10,
    },
  )
  return { app, agent, root, runner }
}

describe('asynchronous derivative API', () => {
  it('queues, reports, serves, and invalidates a video derivative', async () => {
    const test = await fixture()
    const upload = await test.agent
      .post(`${test.root}/uploads`)
      .query({ filename: 'clip.mp4' })
      .set('content-type', 'video/mp4')
      .send(video)
    assert.equal(upload.status, 201)
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')

    const collection = `${test.root}/assets/${upload.body.publicId}/versions/1/derivatives`
    const queued = await test.agent
      .post(collection)
      .send({ operation: 'video_poster', atSeconds: 0, width: 80 })
    const replay = await test.agent
      .post(collection)
      .send({ operation: 'video_poster', atSeconds: 0, width: 80 })
    assert.equal(queued.status, 202)
    assert.equal(queued.body.state, 'queued')
    assert.equal(replay.body.id, queued.body.id)
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')

    const item = `${test.root}/derivatives/${queued.body.id}`
    const ready = await test.agent.get(item)
    assert.equal(ready.status, 200)
    assert.equal(ready.body.state, 'ready')
    assert.equal(ready.body.mimeType, 'image/jpeg')
    const content = await test.agent.get(ready.body.contentPath)
    assert.equal(content.status, 200)
    assert.match(content.headers['content-type'] ?? '', /^image\/jpeg/)
    assert.equal(Number(content.headers['content-length']), ready.body.sizeBytes)

    assert.equal((await test.agent.delete(item)).status, 204)
    assert.equal((await test.agent.get(item)).status, 404)
    assert.equal(
      (await request(test.app).post(collection).send({ operation: 'video_poster' })).status,
      401,
    )
  })

  it('rejects malformed and media-incompatible requests before queueing', async () => {
    const test = await fixture()
    const upload = await test.agent
      .post(`${test.root}/uploads`)
      .query({ filename: 'clip.mp4' })
      .set('content-type', 'video/mp4')
      .send(video)
    assert.equal(await test.runner.runOnce(new AbortController().signal), 'succeeded')
    const collection = `${test.root}/assets/${upload.body.publicId}/versions/1/derivatives`

    assert.equal(
      (await test.agent.post(collection).send({ operation: 'video_poster', width: 100_000 }))
        .status,
      400,
    )
    assert.equal((await test.agent.post(collection).send({ operation: 'pdf_text' })).status, 415)
  })
})
