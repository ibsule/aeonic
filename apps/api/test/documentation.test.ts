import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import request from 'supertest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createOpenApiDocument } from '../src/openapi/document.js'

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    AEONIC_VERSION: '0.3.0-test',
    BETTER_AUTH_URL: 'http://localhost:3001',
  })
}

describe('API documentation', () => {
  it('publishes an OpenAPI 3.1 document for every supported API group', async () => {
    const response = await request(buildApp({ config: testConfig(), logger: false })).get(
      '/openapi.json',
    )

    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'] ?? '', /^application\/json/)
    assert.equal(response.body.openapi, '3.1.2')
    assert.equal(response.body.info.version, '0.3.0-test')
    assert.equal(response.body.servers[0].url, 'http://localhost:3001')

    const paths = Object.keys(response.body.paths)
    for (const expected of [
      '/health/live',
      '/api/v1/setup',
      '/api/auth/sign-in/email',
      '/api/auth/organization/invite-member',
      '/api/v1/organizations/{organizationId}/projects',
      '/api/v1/organizations/{organizationId}/projects/{projectId}/members',
      '/api/v1/organizations/{organizationId}/projects/{projectId}/api-keys',
      '/api/v1/organizations/{organizationId}/audit-events',
    ]) {
      assert.ok(paths.includes(expected), `missing documented path: ${expected}`)
    }
  })

  it('keeps operation identifiers unique and every operation documented with responses', () => {
    const document = createOpenApiDocument(testConfig())
    const operationIds = new Set<string>()
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, value] of Object.entries(pathItem)) {
        if (!methods.has(method)) continue
        const operation = value as { operationId?: unknown; responses?: unknown }
        if (typeof operation.operationId !== 'string') {
          assert.fail(`missing operationId: ${method.toUpperCase()} ${path}`)
        }
        assert.ok(!operationIds.has(operation.operationId), `duplicate: ${operation.operationId}`)
        operationIds.add(operation.operationId)
        assert.equal(typeof operation.responses, 'object', `${method.toUpperCase()} ${path}`)
      }
    }

    assert.ok(operationIds.size >= 18)
  })

  it('serves an interactive reference with a version-pinned browser dependency', async () => {
    const response = await request(buildApp({ config: testConfig(), logger: false })).get('/docs')

    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'] ?? '', /^text\/html/)
    assert.match(response.text, /Aeonic API Reference/)
    assert.match(response.text, /\/openapi\.json/)
    assert.match(response.text, /@scalar\/api-reference@1\.68\.0/)
    assert.doesNotMatch(response.text, /@scalar\/api-reference["']/)
  })
})
