import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createServiceState } from '../src/state.js'

const openApps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

function createTestApp(initiallyReady = true): FastifyInstance {
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', AEONIC_VERSION: 'test-version' }),
    state: createServiceState(initiallyReady),
    logger: false,
  })
  openApps.push(app)
  return app
}

describe('health endpoints', () => {
  it('reports liveness with the running version', async () => {
    const response = await createTestApp().inject({ method: 'GET', url: '/health/live' })

    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'] ?? '', /^application\/json/)
    assert.deepEqual(Object.keys(response.json()).sort(), ['status', 'timestamp', 'version'])
    assert.equal(response.json().status, 'ok')
    assert.equal(response.json().version, 'test-version')
  })

  it('applies API security headers', async () => {
    const response = await createTestApp().inject({ method: 'GET', url: '/health/live' })

    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
  })

  it('reports an RFC 9457 response until the service is ready', async () => {
    const response = await createTestApp(false).inject({ method: 'GET', url: '/health/ready' })
    const body = response.json()

    assert.equal(response.statusCode, 503)
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/)
    assert.equal(body.code, 'service_not_ready')
    assert.equal(body.status, 503)
    assert.ok(body.requestId)
  })

  it('reports readiness after startup', async () => {
    const state = createServiceState()
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      state,
      logger: false,
    })
    openApps.push(app)
    state.markReady()

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().status, 'ready')
  })
})

describe('unregistered routes', () => {
  it('uses RFC 9457 for unknown routes', async () => {
    const response = await createTestApp().inject({ method: 'GET', url: '/missing' })
    const body = response.json()

    assert.equal(response.statusCode, 404)
    assert.match(response.headers['content-type'] ?? '', /^application\/problem\+json/)
    assert.equal(body.code, 'route_not_found')
    assert.equal(body.instance, '/missing')
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
      const response = await app.inject({ method: 'GET', url })
      assert.equal(response.statusCode, 404, `${url} must remain unavailable`)
      assert.equal(response.json().code, 'route_not_found')
    }
  })
})

describe('cross-origin policy', () => {
  it('does not allow cross-origin access by default in production', async () => {
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'production' }),
      logger: false,
    })
    openApps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://untrusted.example' },
    })

    assert.equal(response.headers['access-control-allow-origin'], undefined)
  })
})
