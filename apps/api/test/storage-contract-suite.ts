import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import type { TenantScope } from '../src/repositories/types.js'
import { createStorageObjectKey, StorageError, type StoragePort } from '../src/storage/contracts.js'

export interface StorageContractFixture {
  storage: StoragePort
  scope: TenantScope
  dispose?(): Promise<void> | void
}

interface StorageContractOptions {
  skip?: boolean | string
}

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function expectStorageCode(code: StorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StorageError && error.code === code
}

export function storageContractSuite(
  name: string,
  createFixture: () => Promise<StorageContractFixture>,
  options: StorageContractOptions = {},
): void {
  describe(name, { skip: options.skip }, () => {
    it('stores, inspects, ranges, and protects immutable objects', async () => {
      const fixture = await createFixture()
      try {
        const key = createStorageObjectKey(fixture.scope, 'original', uuidv7())
        const content = Buffer.from('a portable storage contract object')
        const sha256 = createHash('sha256').update(content).digest('hex')

        const stored = await fixture.storage.put(
          fixture.scope,
          key,
          Readable.from([content.subarray(0, 9), content.subarray(9)]),
          {
            maxBytes: 1_024,
            expectedBytes: content.byteLength,
            expectedSha256: sha256,
          },
        )
        assert.deepEqual(stored, { key, sizeBytes: content.byteLength, sha256 })
        const metadata = await fixture.storage.head(fixture.scope, key)
        assert.equal(metadata.key, key)
        assert.equal(metadata.sizeBytes, content.byteLength)
        assert.ok(metadata.modifiedAt instanceof Date)
        assert.deepEqual(await consume(await fixture.storage.open(fixture.scope, key)), content)
        assert.deepEqual(
          await consume(
            await fixture.storage.open(fixture.scope, key, { range: { start: 2, end: 10 } }),
          ),
          content.subarray(2, 11),
        )

        await assert.rejects(
          fixture.storage.put(fixture.scope, key, Readable.from('replacement'), {
            maxBytes: 100,
          }),
          expectStorageCode('already_exists'),
        )
        assert.deepEqual(await consume(await fixture.storage.open(fixture.scope, key)), content)
        await fixture.storage.delete(fixture.scope, key)
      } finally {
        await fixture.dispose?.()
      }
    })

    it('rejects invalid content, ranges, and tenant scope without publishing', async () => {
      const fixture = await createFixture()
      try {
        const sizeKey = createStorageObjectKey(fixture.scope, 'temporary', uuidv7())
        await assert.rejects(
          fixture.storage.put(fixture.scope, sizeKey, Readable.from('too large'), {
            maxBytes: 3,
          }),
          expectStorageCode('size_exceeded'),
        )
        await assert.rejects(
          fixture.storage.head(fixture.scope, sizeKey),
          expectStorageCode('not_found'),
        )

        const checksumKey = createStorageObjectKey(fixture.scope, 'temporary', uuidv7())
        await assert.rejects(
          fixture.storage.put(fixture.scope, checksumKey, Readable.from('content'), {
            maxBytes: 20,
            expectedSha256: '0'.repeat(64),
          }),
          expectStorageCode('checksum_mismatch'),
        )
        await assert.rejects(
          fixture.storage.head(fixture.scope, checksumKey),
          expectStorageCode('not_found'),
        )

        const validKey = createStorageObjectKey(fixture.scope, 'temporary', uuidv7())
        await fixture.storage.put(fixture.scope, validKey, Readable.from('content'), {
          maxBytes: 20,
        })
        await assert.rejects(
          fixture.storage.open(fixture.scope, validKey, { range: { start: 2, end: 99 } }),
          expectStorageCode('invalid_range'),
        )
        await assert.rejects(
          fixture.storage.open({ ...fixture.scope, projectId: uuidv7() }, validKey),
          expectStorageCode('invalid_key'),
        )
        await fixture.storage.delete(fixture.scope, validKey)
      } finally {
        await fixture.dispose?.()
      }
    })

    it('supports empty objects, idempotent deletion, and writable health checks', async () => {
      const fixture = await createFixture()
      try {
        const key = createStorageObjectKey(fixture.scope, 'derivative', uuidv7())
        const emptySha256 = createHash('sha256').digest('hex')
        assert.deepEqual(
          await fixture.storage.put(fixture.scope, key, Readable.from([]), {
            maxBytes: 0,
            expectedBytes: 0,
            expectedSha256: emptySha256,
          }),
          { key, sizeBytes: 0, sha256: emptySha256 },
        )
        assert.deepEqual(
          await consume(await fixture.storage.open(fixture.scope, key)),
          Buffer.alloc(0),
        )
        await fixture.storage.delete(fixture.scope, key)
        await fixture.storage.delete(fixture.scope, key)
        await assert.rejects(
          fixture.storage.open(fixture.scope, key),
          expectStorageCode('not_found'),
        )

        const health = await fixture.storage.health()
        assert.equal(health.status, 'available')
        assert.equal(health.writable, true)
      } finally {
        await fixture.dispose?.()
      }
    })
  })
}
