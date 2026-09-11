import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { type DatabaseConnection, openDatabase } from '../src/db/database.js'
import { createStorageRuntime, type StorageRuntime } from '../src/storage/factory.js'

const endpoint = process.env.S3_TEST_ENDPOINT
const accessKeyId = process.env.S3_TEST_ACCESS_KEY
const secretAccessKey = process.env.S3_TEST_SECRET_KEY
const enabled = endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined
const bucket = process.env.S3_TEST_BUCKET ?? `aeonic-delivery-${randomUUID()}`
const region = process.env.S3_TEST_REGION ?? 'us-east-1'
const prefix = `delivery-runs/${randomUUID()}`
const tusDirectory = join(tmpdir(), `aeonic-s3-tus-${randomUUID()}`)
const administration = enabled
  ? new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
  : null
let createdBucket = false
let database: DatabaseConnection | null = null
let storage: StorageRuntime | null = null

before(async () => {
  if (administration === null || process.env.S3_TEST_CREATE_BUCKET !== '1') return
  await administration.send(new CreateBucketCommand({ Bucket: bucket }))
  createdBucket = true
})

after(async () => {
  database?.close()
  storage?.close()
  await rm(tusDirectory, { recursive: true, force: true })
  if (administration === null) return
  const listed = await administration.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }),
  )
  if (listed.Contents && listed.Contents.length > 0) {
    await administration.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })) },
      }),
    )
  }
  if (createdBucket) await administration.send(new DeleteBucketCommand({ Bucket: bucket }))
  administration.destroy()
})

describe('S3-backed original delivery', { skip: !enabled }, () => {
  it('preserves simple, resumable, delivery, and usage behavior through the HTTP API', async () => {
    assert.ok(endpoint && accessKeyId && secretAccessKey)
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
      DELIVERY_SIGNING_KEYS: `test:${Buffer.alloc(32, 7).toString('base64url')}`,
      STORAGE_BACKEND: 's3',
      TUS_STORAGE_PATH: tusDirectory,
      S3_BUCKET: bucket,
      S3_REGION: region,
      S3_ENDPOINT: endpoint,
      S3_ALLOW_INSECURE_ENDPOINT: String(endpoint.startsWith('http://')),
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_PREFIX: prefix,
    })
    database = openDatabase(config)
    database.migrate()
    storage = createStorageRuntime(config)
    await storage.port.initialize()
    const app = buildApp({
      config,
      database,
      storage,
      auth: createAuth(config, database),
      logger: false,
    })
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
    const content = Buffer.concat([
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      Buffer.from('s3-range-check'),
    ])
    const uploaded = await agent
      .post(
        `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}/uploads`,
      )
      .query({ filename: 's3.png', visibility: 'public' })
      .set('content-type', 'image/png')
      .send(content)
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    database.client.prepare("update assets set state = 'ready'").run()
    database.client.prepare("update asset_versions set state = 'ready'").run()
    const path = `/m/${setup.body.projectId}/${uploaded.body.publicId}/v1/original/s3.png`

    const full = await request(app).get(path)
    const partial = await request(app).get(path).set('range', 'bytes=4-12')

    assert.equal(full.status, 200)
    assert.deepEqual(full.body, content)
    assert.equal(partial.status, 206)
    assert.deepEqual(partial.body, content.subarray(4, 13))
    assert.equal(partial.headers['content-range'], `bytes 4-12/${content.byteLength}`)

    const tusMetadata = [
      `filename ${Buffer.from('resumable.png').toString('base64')}`,
      `filetype ${Buffer.from('image/png').toString('base64')}`,
    ].join(',')
    const tusCreated = await agent
      .post(
        `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}/tus`,
      )
      .set('tus-resumable', '1.0.0')
      .set('upload-length', String(content.byteLength))
      .set('upload-metadata', tusMetadata)
      .send()
    const tusCompleted = await agent
      .patch(tusCreated.headers.location as string)
      .set('tus-resumable', '1.0.0')
      .set('upload-offset', '0')
      .set('content-type', 'application/offset+octet-stream')
      .send(content)
    const overview = await agent.get(
      `/api/v1/organizations/${setup.body.organizationId}/projects/${setup.body.projectId}/storage`,
    )

    assert.equal(tusCreated.status, 201)
    assert.equal(tusCompleted.status, 204)
    assert.equal(tusCompleted.headers['upload-offset'], String(content.byteLength))
    assert.equal(overview.status, 200)
    assert.equal(overview.body.backend, 's3')
    assert.equal(overview.body.usage.usedBytes, content.byteLength * 2)
    assert.equal(overview.body.usage.reservedBytes, 0)
    assert.equal(overview.body.health.status, 'available')
  })
})
