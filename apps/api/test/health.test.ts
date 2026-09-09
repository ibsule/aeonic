import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Express } from 'express'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createServiceState } from '../src/state.js'

function createTestApp(initiallyReady = true): Express {
  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', AEONIC_VERSION: 'test-version' }),
    state: createServiceState(initiallyReady),
    logger: false,
  })
}

describe('health endpoints', () => {
  it('reports liveness with the running version', async () => {
    const response = await request(createTestApp()).get('/health/live')

    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'] ?? '', /^application\/json/)
    assert.deepEqual(Object.keys(response.body).sort(), ['status', 'timestamp', 'version'])
    assert.equal(response.body.status, 'ok')
    assert.equal(response.body.version, 'test-version')
    assert.ok(response.headers['x-request-id'])
  })

  it('applies API security headers', async () => {
    const response = await request(createTestApp()).get('/health/live')

    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    assert.equal(response.headers['x-powered-by'], undefined)
  })

  it('reports an RFC 9457 response until the service is ready', async () => {
    const response = await request(createTestApp(false)).get('/health/ready')

    assert.equal(response.status, 503)
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/)
    assert.equal(response.body.code, 'service_not_ready')
    assert.equal(response.body.status, 503)
    assert.ok(response.body.requestId)
  })

  it('reports readiness after startup', async () => {
    const state = createServiceState()
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      state,
      logger: false,
    })
    state.markReady()

    const response = await request(app).get('/health/ready')

    assert.equal(response.status, 200)
    assert.equal(response.body.status, 'ready')
  })
})

describe('unregistered routes', () => {
  it('uses RFC 9457 for unknown routes', async () => {
    const response = await request(createTestApp()).get('/missing')

    assert.equal(response.status, 404)
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/)
    assert.equal(response.body.code, 'route_not_found')
    assert.equal(response.body.instance, '/missing')
  })

  it('keeps the unsafe legacy file surface disabled', async () => {
    const app = createTestApp()
    const legacyUrls = [
      '/upload',
      '/files/example.jpg',
      '/files/%2e%2e/%2e%2e/etc/passwd',
      '/admin/stats',
      '/auth/sign-up',
    ]

    for (const url of legacyUrls) {
      const response = await request(app).get(url)
      assert.equal(response.status, 404, `${url} must remain unavailable`)
      assert.equal(response.body.code, 'route_not_found')
    }
  })
})

describe('request failures', () => {
  it('returns an RFC 9457 response for malformed JSON', async () => {
    const response = await request(createTestApp())
      .post('/missing')
      .type('application/json')
      .send('{"incomplete":')

    assert.equal(response.status, 400)
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/)
    assert.equal(response.body.code, 'invalid_json')
  })

  it('enforces the configured JSON body limit', async () => {
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', MAX_JSON_BODY_BYTES: '1024' }),
      logger: false,
    })
    const response = await request(app)
      .post('/missing')
      .send({ content: 'x'.repeat(2_000) })

    assert.equal(response.status, 413)
    assert.equal(response.body.code, 'request_too_large')
  })
})

describe('cross-origin policy', () => {
  it('does not allow cross-origin access by default in production', async () => {
    const app = buildApp({
      config: loadConfig({
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: 'a-secure-production-secret-with-32-characters',
        BETTER_AUTH_URL: 'https://media.example.com',
      }),
      logger: false,
    })

    const response = await request(app)
      .get('/health/live')
      .set('origin', 'https://untrusted.example')

    assert.equal(response.headers['access-control-allow-origin'], undefined)
  })
})
