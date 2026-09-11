import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StorageError } from '../src/storage/contracts.js'
import { S3Storage } from '../src/storage/s3-storage.js'

function expectStorageCode(code: StorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof StorageError && error.code === code
}

describe('S3-compatible storage configuration', () => {
  it('requires explicit approval for plaintext endpoints', () => {
    assert.throws(
      () => new S3Storage({ bucket: 'assets', region: 'us-east-1', endpoint: 'http://minio:9000' }),
      expectStorageCode('invalid_input'),
    )
  })

  it('accepts an explicitly approved local S3 endpoint', () => {
    const storage = new S3Storage({
      bucket: 'assets',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      allowInsecureEndpoint: true,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' },
    })
    storage.destroy()
  })

  it('rejects unsafe prefixes and multipart settings', () => {
    assert.throws(
      () => new S3Storage({ bucket: 'assets', region: 'us-east-1', prefix: '../outside' }),
      expectStorageCode('invalid_input'),
    )
    assert.throws(
      () =>
        new S3Storage({
          bucket: 'assets',
          region: 'us-east-1',
          multipartPartSizeBytes: 1024,
        }),
      expectStorageCode('invalid_input'),
    )
    assert.throws(
      () =>
        new S3Storage({
          bucket: 'assets',
          region: 'us-east-1',
          multipartPartSizeBytes: 6 * 1024 * 1024 * 1024,
        }),
      expectStorageCode('invalid_input'),
    )
    assert.throws(
      () => new S3Storage({ bucket: 'assets', region: 'us-east-1', multipartConcurrency: 17 }),
      expectStorageCode('invalid_input'),
    )
  })

  it('requires the KMS encryption mode when a key is configured', () => {
    assert.throws(
      () =>
        new S3Storage({
          bucket: 'assets',
          region: 'us-east-1',
          serverSideEncryption: 'AES256',
          kmsKeyId: 'alias/media',
        }),
      expectStorageCode('invalid_input'),
    )
  })

  it('rejects ambiguous endpoints, empty credentials, and unsafe retry counts', () => {
    assert.throws(
      () =>
        new S3Storage({
          bucket: 'assets',
          region: 'us-east-1',
          endpoint: 'https://user:secret@example.com?override=true',
        }),
      expectStorageCode('invalid_input'),
    )
    assert.throws(
      () =>
        new S3Storage({
          bucket: 'assets',
          region: 'us-east-1',
          credentials: { accessKeyId: '', secretAccessKey: '' },
        }),
      expectStorageCode('invalid_input'),
    )
    assert.throws(
      () => new S3Storage({ bucket: 'assets', region: 'us-east-1', maxAttempts: 0 }),
      expectStorageCode('invalid_input'),
    )
  })
})
