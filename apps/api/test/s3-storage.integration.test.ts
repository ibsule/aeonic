import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { v7 as uuidv7 } from 'uuid'
import { createStorageObjectKey } from '../src/storage/contracts.js'
import { S3Storage, type S3StorageOptions } from '../src/storage/s3-storage.js'
import { storageContractSuite } from './storage-contract-suite.js'

const endpoint = process.env.S3_TEST_ENDPOINT
const accessKeyId = process.env.S3_TEST_ACCESS_KEY
const secretAccessKey = process.env.S3_TEST_SECRET_KEY
const enabled = endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined
const bucket = process.env.S3_TEST_BUCKET ?? `aeonic-contract-${randomUUID()}`
const region = process.env.S3_TEST_REGION ?? 'us-east-1'
const prefix = `runs/${randomUUID()}`

const options: S3StorageOptions | null = enabled
  ? {
      bucket,
      region,
      endpoint,
      allowInsecureEndpoint: endpoint.startsWith('http://'),
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      prefix,
      multipartPartSizeBytes: 5 * 1024 * 1024,
      multipartConcurrency: 2,
    }
  : null

function createAdministrationClient(): S3Client | null {
  if (endpoint === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    return null
  }
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

const administration = createAdministrationClient()
let createdBucket = false

before(async () => {
  if (administration === null || process.env.S3_TEST_CREATE_BUCKET !== '1') return
  await administration.send(new CreateBucketCommand({ Bucket: bucket }))
  createdBucket = true
})

after(async () => {
  if (administration === null) return
  let continuationToken: string | undefined
  do {
    const page = await administration.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken,
      }),
    )
    if (page.Contents !== undefined && page.Contents.length > 0) {
      await administration.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
        }),
      )
    }
    continuationToken = page.NextContinuationToken
  } while (continuationToken !== undefined)
  if (createdBucket) {
    await administration.send(new DeleteBucketCommand({ Bucket: bucket }))
  }
  administration.destroy()
})

storageContractSuite(
  'S3-compatible storage contract',
  async () => {
    assert.ok(options !== null)
    const storage = new S3Storage(options)
    const scope = { organizationId: uuidv7(), projectId: uuidv7() }
    return { storage, scope, dispose: () => storage.destroy() }
  },
  { skip: enabled ? false : 'S3 integration credentials are not configured' },
)

describe('S3-compatible multipart storage', { skip: !enabled }, () => {
  it('classifies rejected credentials without exposing provider errors', async () => {
    assert.ok(options !== null)
    const storage = new S3Storage({
      ...options,
      maxAttempts: 1,
      credentials: { accessKeyId: 'rejected', secretAccessKey: 'rejected-secret' },
    })
    try {
      await assert.rejects(
        storage.initialize(),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'denied' &&
          'retryable' in error &&
          error.retryable === false,
      )
    } finally {
      storage.destroy()
    }
  })

  it('streams an object across multiple checksummed parts', async () => {
    assert.ok(options !== null)
    const storage = new S3Storage(options)
    const scope = { organizationId: uuidv7(), projectId: uuidv7() }
    const key = createStorageObjectKey(scope, 'original', uuidv7())
    const first = Buffer.alloc(4 * 1024 * 1024, 0x61)
    const second = Buffer.alloc(2 * 1024 * 1024, 0x62)
    try {
      const stored = await storage.put(scope, key, Readable.from([first, second]), {
        maxBytes: first.byteLength + second.byteLength,
        expectedBytes: first.byteLength + second.byteLength,
      })
      assert.equal(stored.sizeBytes, first.byteLength + second.byteLength)
      assert.equal((await storage.head(scope, key)).sizeBytes, stored.sizeBytes)
      await storage.delete(scope, key)
    } finally {
      storage.destroy()
    }
  })

  it('aborts uploaded parts when integrity validation fails', async () => {
    assert.ok(options !== null)
    assert.ok(administration !== null)
    const storage = new S3Storage(options)
    const scope = { organizationId: uuidv7(), projectId: uuidv7() }
    const key = createStorageObjectKey(scope, 'temporary', uuidv7())
    const content = Buffer.alloc(6 * 1024 * 1024, 0x61)
    try {
      await assert.rejects(
        storage.put(scope, key, Readable.from(content), {
          maxBytes: content.byteLength,
          expectedBytes: content.byteLength,
          expectedSha256: '0'.repeat(64),
        }),
        (error) => error instanceof Error && 'code' in error && error.code === 'checksum_mismatch',
      )
      const uploads = await administration.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `${prefix}/${key}` }),
      )
      assert.deepEqual(uploads.Uploads ?? [], [])
    } finally {
      storage.destroy()
    }
  })
})
