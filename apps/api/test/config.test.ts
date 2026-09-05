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
  })

  it('does not enable cross-origin access by default in production', () => {
    const config = loadConfig({ NODE_ENV: 'production' })

    assert.deepEqual(config.corsOrigins, [])
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
})
