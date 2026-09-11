import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigurationError, loadConfig } from '../src/config.js'

describe('configuration', () => {
  it('uses safe development defaults', () => {
    const config = loadConfig({})

    assert.equal(config.environment, 'development')
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 3001)
    assert.deepEqual(config.corsOrigins, ['http://localhost:3000'])
    assert.equal(config.trustProxy, false)
    assert.equal(config.databasePath, 'data/aeonic.db')
    assert.equal(config.databaseBusyTimeoutMs, 5_000)
    assert.equal(config.databaseWalAutocheckpointPages, 1_000)
    assert.equal(config.storageBackend, 'local')
    assert.equal(config.localStoragePath, 'data/objects')
    assert.equal(config.uploadMaxBytes, 100 * 1024 * 1024)
    assert.equal(config.projectStorageQuotaBytes, 10 * 1024 * 1024 * 1024)
    assert.equal(config.uploadStaleAfterMs, 60 * 60 * 1_000)
    assert.equal(config.authBaseUrl, 'http://localhost:3001')
    assert.equal(config.version, '0.3.0')
  })

  it('does not enable cross-origin access by default in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
      BETTER_AUTH_URL: 'https://media.example.com',
    })

    assert.deepEqual(config.corsOrigins, [])
  })

  it('requires secure authentication configuration in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigurationError)
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
          BETTER_AUTH_URL: 'http://media.example.com',
        }),
      ConfigurationError,
    )
  })

  it('rejects invalid ports and origins', () => {
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigurationError)
    assert.throws(
      () => loadConfig({ CORS_ORIGINS: 'https://example.com/path' }),
      ConfigurationError,
    )
  })

  it('parses an explicit origin allowlist', () => {
    const config = loadConfig({
      CORS_ORIGINS: 'https://app.example.com,http://localhost:3000',
      TRUST_PROXY: 'true',
    })

    assert.deepEqual(config.corsOrigins, ['https://app.example.com', 'http://localhost:3000'])
    assert.equal(config.trustProxy, true)
  })

  it('validates S3 storage configuration and credential pairs', () => {
    assert.throws(() => loadConfig({ STORAGE_BACKEND: 's3' }), ConfigurationError)
    assert.throws(
      () =>
        loadConfig({
          STORAGE_BACKEND: 's3',
          S3_BUCKET: 'media',
          S3_ACCESS_KEY_ID: 'key',
        }),
      ConfigurationError,
    )

    const config = loadConfig({
      STORAGE_BACKEND: 's3',
      S3_BUCKET: 'media',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ALLOW_INSECURE_ENDPOINT: 'true',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    })
    assert.equal(config.storageBackend, 's3')
    assert.equal(config.s3Bucket, 'media')
    assert.equal(config.s3ForcePathStyle, true)
  })
})
