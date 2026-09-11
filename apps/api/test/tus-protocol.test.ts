import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import { ApiError } from '../src/http/api-error.js'
import {
  parseTusChecksum,
  parseTusInteger,
  parseTusMetadata,
  requireTusVersion,
} from '../src/uploads/tus-protocol.js'
import {
  TusChecksumMismatchError,
  TusOffsetMismatchError,
  TusStagingStore,
} from '../src/uploads/tus-staging.js'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('tus protocol parsing', () => {
  it('accepts version 1.0.0 and safe canonical metadata', () => {
    requireTusVersion('1.0.0')
    const raw = `filename ${Buffer.from('résumé.pdf').toString('base64')},filetype ${Buffer.from('application/pdf').toString('base64')}`
    const metadata = parseTusMetadata(raw)

    assert.equal(metadata.raw, raw)
    assert.equal(metadata.values.get('filename'), 'résumé.pdf')
    assert.equal(metadata.values.get('filetype'), 'application/pdf')
    assert.equal(parseTusInteger('0', 'Upload-Offset'), 0)
    assert.throws(() => requireTusVersion('0.2.2'), ApiError)
    assert.throws(() => parseTusInteger('01', 'Upload-Offset'), ApiError)
  })

  it('rejects duplicated, malformed, and non-UTF-8 metadata', () => {
    assert.throws(() => parseTusMetadata('filename Zg==,filename Zg=='), ApiError)
    assert.throws(() => parseTusMetadata('filename !!!,filetype Zg=='), ApiError)
    assert.throws(() => parseTusMetadata('filename /w==,filetype YXBwbGljYXRpb24vcGRm'), ApiError)
  })

  it('supports the required SHA-1 checksum and SHA-256', () => {
    const content = Buffer.from('verified chunk')
    const sha1 = createHash('sha1').update(content).digest('base64')
    const sha256 = createHash('sha256').update(content).digest('base64')

    assert.equal(parseTusChecksum(`sha1 ${sha1}`)?.algorithm, 'sha1')
    assert.equal(parseTusChecksum(`sha256 ${sha256}`)?.algorithm, 'sha256')
    assert.throws(() => parseTusChecksum('md5 CY9rzUYh03PK3k6DJie09g=='), ApiError)
  })
})

describe('tus staging store', () => {
  it('appends verified chunks without exposing a mismatched chunk', async () => {
    const directory = join(tmpdir(), `aeonic-tus-${uuidv7()}`)
    directories.push(directory)
    const store = new TusStagingStore(directory)
    const uploadId = uuidv7()
    const first = Buffer.from('first')
    const second = Buffer.from('-second')
    await store.create(uploadId)

    const firstBytes = await store.append(uploadId, Readable.from(first), {
      offset: 0,
      maxBytes: 12,
      checksum: {
        algorithm: 'sha256',
        digest: createHash('sha256').update(first).digest(),
      },
    })
    await assert.rejects(
      store.append(uploadId, Readable.from(second), {
        offset: firstBytes,
        maxBytes: second.byteLength,
        checksum: { algorithm: 'sha1', digest: Buffer.alloc(20) },
      }),
      TusChecksumMismatchError,
    )

    assert.equal(await store.size(uploadId), first.byteLength)
    await assert.rejects(
      store.append(uploadId, Readable.from(second), {
        offset: 0,
        maxBytes: second.byteLength,
      }),
      (error: unknown) =>
        error instanceof TusOffsetMismatchError && error.actualOffset === first.byteLength,
    )
    await store.append(uploadId, Readable.from(second), {
      offset: first.byteLength,
      maxBytes: second.byteLength,
    })
    assert.equal(await store.size(uploadId), first.byteLength + second.byteLength)
    assert.equal(
      await store.sha256(uploadId),
      createHash('sha256')
        .update(Buffer.concat([first, second]))
        .digest('hex'),
    )
  })
})
