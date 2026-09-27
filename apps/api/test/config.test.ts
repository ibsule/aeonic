import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ConfigurationError, loadConfig } from '../src/config.js'

describe('configuration', () => {
  it('uses safe development defaults', () => {
    const config = loadConfig({})

    assert.equal(config.environment, 'development')
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.port, 3001)
    assert.deepEqual(config.corsOrigins, ['http://localhost:4173'])
    assert.equal(config.trustProxy, false)
    assert.equal(config.databasePath, 'data/aeonic.db')
    assert.equal(config.databaseBusyTimeoutMs, 5_000)
    assert.equal(config.databaseWalAutocheckpointPages, 1_000)
    assert.equal(config.storageBackend, 'local')
    assert.equal(config.localStoragePath, 'data/objects')
    assert.equal(config.uploadMaxBytes, 100 * 1024 * 1024)
    assert.equal(config.tusStoragePath, 'data/tus')
    assert.equal(config.tusUploadMaxBytes, 5 * 1024 * 1024 * 1024)
    assert.equal(config.tusUploadExpirationMs, 24 * 60 * 60 * 1_000)
    assert.equal(config.projectStorageQuotaBytes, 10 * 1024 * 1024 * 1024)
    assert.equal(config.workerLeaseMs, 30_000)
    assert.equal(config.workerHeartbeatMs, 10_000)
    assert.equal(config.imageMaxInputPixels, 100_000_000)
    assert.equal(config.uploadStaleAfterMs, 60 * 60 * 1_000)
    assert.equal(config.deliveryBaseUrl, 'http://localhost:3001')
    assert.equal(config.deliverySigningKeys[0]?.id, 'development')
    assert.equal(config.deliveryUrlTtlSeconds, 900)
    assert.equal(config.publicDeliveryCacheSeconds, 365 * 24 * 60 * 60)
    assert.equal(config.authBaseUrl, 'http://localhost:3001')
    assert.equal(config.aiEnabled, false)
    assert.equal(config.aiProvider, 'openai')
    assert.equal(config.aiProviderApiKey, undefined)
    assert.equal(config.aiEmbeddingDimensions, 1_024)
    assert.equal(config.aiPipelineVersion, 'semantic-v1')
    assert.equal(config.aiInputMicroUsdPerMillionUnits, 0)
    assert.equal(config.aiOutputMicroUsdPerMillionUnits, 0)
    assert.equal(config.qdrantUrl, 'http://qdrant:6333')
    assert.equal(config.version, '0.6.0')
  })

  it('does not enable cross-origin access by default in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
      BETTER_AUTH_URL: 'https://media.example.com',
      DELIVERY_SIGNING_KEYS: `primary:${Buffer.alloc(32, 1).toString('base64url')}`,
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
          DELIVERY_SIGNING_KEYS: `primary:${Buffer.alloc(32, 1).toString('base64url')}`,
        }),
      ConfigurationError,
    )
  })

  it('requires strong, rotation-ready delivery signing keys in production', () => {
    const production = {
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
      BETTER_AUTH_URL: 'https://media.example.com',
    }
    assert.throws(() => loadConfig(production), ConfigurationError)
    assert.throws(
      () => loadConfig({ ...production, DELIVERY_SIGNING_KEYS: 'primary:too-short' }),
      ConfigurationError,
    )

    const config = loadConfig({
      ...production,
      DELIVERY_BASE_URL: 'https://cdn.example.com',
      DELIVERY_SIGNING_KEYS: `current:${Buffer.alloc(32, 1).toString('base64url')},previous:${Buffer.alloc(32, 2).toString('base64url')}`,
    })
    assert.equal(config.deliveryBaseUrl, 'https://cdn.example.com')
    assert.deepEqual(
      config.deliverySigningKeys.map((key) => key.id),
      ['current', 'previous'],
    )
  })

  it('rejects invalid ports and origins', () => {
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigurationError)
    assert.throws(
      () => loadConfig({ CORS_ORIGINS: 'https://example.com/path' }),
      ConfigurationError,
    )
  })

  it('requires worker heartbeats to leave enough lease safety margin', () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'test',
          WORKER_LEASE_MS: '10000',
          WORKER_HEARTBEAT_MS: '5000',
        }),
      /WORKER_HEARTBEAT_MS must be less than half WORKER_LEASE_MS/,
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

  it('keeps AI optional and validates an explicitly enabled provider', () => {
    assert.throws(
      () => loadConfig({ AI_ENABLED: 'true' }),
      /enabled AI requires provider credentials/,
    )

    const config = loadConfig({
      AI_ENABLED: 'true',
      AI_PROVIDER_API_KEY: 'local-provider-key',
      AI_VISION_MODEL: 'vision-model-snapshot',
      AI_EMBEDDING_MODEL: 'embedding-model-snapshot',
      AI_EMBEDDING_DIMENSIONS: '768',
      QDRANT_URL: 'http://localhost:6333',
    })

    assert.equal(config.aiEnabled, true)
    assert.equal(config.aiProviderApiKey, 'local-provider-key')
    assert.equal(config.aiVisionModel, 'vision-model-snapshot')
    assert.equal(config.aiEmbeddingModel, 'embedding-model-snapshot')
    assert.equal(config.aiEmbeddingDimensions, 768)
  })

  it('requires secret files for production AI credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aeonic-ai-config-'))
    const providerSecret = join(directory, 'provider')
    const qdrantSecret = join(directory, 'qdrant')
    writeFileSync(providerSecret, 'provider-secret\n', { mode: 0o600 })
    writeFileSync(qdrantSecret, 'qdrant-secret\n', { mode: 0o600 })
    const production = {
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
      BETTER_AUTH_URL: 'https://media.example.com',
      DELIVERY_SIGNING_KEYS: `primary:${Buffer.alloc(32, 1).toString('base64url')}`,
      AI_ENABLED: 'true',
      AI_VISION_MODEL: 'vision-model-snapshot',
      AI_EMBEDDING_MODEL: 'embedding-model-snapshot',
    }

    try {
      assert.throws(
        () => loadConfig({ ...production, AI_PROVIDER_API_KEY: 'inline-secret' }),
        /must be provided through AI_PROVIDER_API_KEY_FILE/,
      )
      const config = loadConfig({
        ...production,
        AI_PROVIDER_API_KEY_FILE: providerSecret,
        QDRANT_API_KEY_FILE: qdrantSecret,
      })
      assert.equal(config.aiProviderApiKey, 'provider-secret')
      assert.equal(config.qdrantApiKey, 'qdrant-secret')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
