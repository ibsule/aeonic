import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createStorageObjectKey,
  StorageError,
  type StorageObjectKey,
} from '../src/storage/contracts.js'
import { LocalStorage } from '../src/storage/local-storage.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function createStorage() {
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-local-storage-'))
  temporaryDirectories.push(directory)
  const rootDirectory = join(directory, 'objects')
  const storage = new LocalStorage({ rootDirectory })
  const scope = { organizationId: uuidv7(), projectId: uuidv7() }
  await storage.initialize()
  return { directory, rootDirectory, scope, storage }
}

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function expectStorageCode(code: StorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StorageError && error.code === code
}

describe('local storage', () => {
  it('atomically stores, inspects, and streams immutable objects', async () => {
    const { scope, storage } = await createStorage()
    const key = createStorageObjectKey(scope, 'original', uuidv7())
    const content = Buffer.from('a production-quality media object')
    const sha256 = createHash('sha256').update(content).digest('hex')

    const stored = await storage.put(
      scope,
      key,
      Readable.from([content.subarray(0, 8), content.subarray(8)]),
      {
        maxBytes: 1_024,
        expectedBytes: content.byteLength,
        expectedSha256: sha256,
      },
    )

    assert.deepEqual(stored, { key, sizeBytes: content.byteLength, sha256 })
    const metadata = await storage.head(scope, key)
    assert.equal(metadata.key, key)
    assert.equal(metadata.sizeBytes, content.byteLength)
    assert.ok(metadata.modifiedAt instanceof Date)
    assert.deepEqual(await consume(await storage.open(scope, key)), content)
    assert.equal(
      (await consume(await storage.open(scope, key, { range: { start: 2, end: 11 } }))).toString(),
      content.subarray(2, 12).toString(),
    )

    await assert.rejects(
      storage.put(scope, key, Readable.from('replacement'), { maxBytes: 100 }),
      expectStorageCode('already_exists'),
    )
    assert.deepEqual(await consume(await storage.open(scope, key)), content)
  })

  it('rejects invalid sizes, checksums, ranges, and tenant scope', async () => {
    const { scope, storage } = await createStorage()
    const key = createStorageObjectKey(scope, 'temporary', uuidv7())

    await assert.rejects(
      storage.put(scope, key, Readable.from('too large'), { maxBytes: 3 }),
      expectStorageCode('size_exceeded'),
    )
    await assert.rejects(
      storage.put(scope, key, Readable.from('short'), { maxBytes: 20, expectedBytes: 6 }),
      expectStorageCode('size_mismatch'),
    )
    await assert.rejects(
      storage.put(scope, key, Readable.from('content'), {
        maxBytes: 20,
        expectedSha256: '0'.repeat(64),
      }),
      expectStorageCode('checksum_mismatch'),
    )

    await storage.put(scope, key, Readable.from('content'), { maxBytes: 20 })
    await assert.rejects(
      storage.open(scope, key, { range: { start: 2, end: 99 } }),
      expectStorageCode('invalid_range'),
    )
    await assert.rejects(
      storage.open({ ...scope, projectId: uuidv7() }, key),
      expectStorageCode('invalid_key'),
    )
  })

  it('cleans staging files after failed and aborted writes', async () => {
    const { rootDirectory, scope, storage } = await createStorage()
    const key = createStorageObjectKey(scope, 'temporary', uuidv7())
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      storage.put(scope, key, Readable.from('content'), {
        maxBytes: 20,
        signal: controller.signal,
      }),
      expectStorageCode('aborted'),
    )

    const entries = await readdir(rootDirectory, { recursive: true })
    assert.ok(entries.every((entry) => !entry.includes('.stage-')))
    await assert.rejects(storage.head(scope, key), expectStorageCode('not_found'))
  })

  it('does not follow a symbolic link at an object path', async () => {
    const { directory, rootDirectory, scope, storage } = await createStorage()
    const key = createStorageObjectKey(scope, 'original', uuidv7())
    const targetPath = resolve(rootDirectory, ...key.split('/'))
    const outsidePath = join(directory, 'outside.txt')
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(outsidePath, 'outside')
    await symlink(outsidePath, targetPath)

    await assert.rejects(storage.open(scope, key), expectStorageCode('invalid_key'))
    await assert.rejects(
      storage.put(scope, key, Readable.from('overwrite'), { maxBytes: 20 }),
      expectStorageCode('already_exists'),
    )
    await assert.rejects(storage.delete(scope, key), expectStorageCode('invalid_key'))
    assert.equal(await readFile(outsidePath, 'utf8'), 'outside')
  })

  it('deletes idempotently and reports filesystem health and capacity', async () => {
    const { scope, storage } = await createStorage()
    const key = createStorageObjectKey(scope, 'derivative', uuidv7())
    await storage.put(scope, key, Readable.from('derived'), { maxBytes: 20 })

    await storage.delete(scope, key)
    await storage.delete(scope, key)
    await assert.rejects(storage.open(scope, key), expectStorageCode('not_found'))

    const health = await storage.health()
    assert.equal(health.status, 'available')
    assert.equal(health.writable, true)
    assert.ok(health.capacity !== null)
    assert.ok((health.capacity?.totalBytes ?? 0n) > 0n)
    assert.ok((health.capacity?.availableBytes ?? 0n) >= 0n)
  })

  it('rejects handcrafted traversal keys before accessing the filesystem', async () => {
    const { scope, storage } = await createStorage()
    await assert.rejects(
      storage.open(
        scope,
        `original/${scope.organizationId}/${scope.projectId}/aa/bb/../../outside` as StorageObjectKey,
      ),
      expectStorageCode('invalid_key'),
    )
  })
})
