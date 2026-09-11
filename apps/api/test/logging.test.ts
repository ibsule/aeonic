import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactCapabilityUrl } from '../src/logging.js'

describe('logging redaction', () => {
  it('removes complete signed query strings while retaining the delivery route', () => {
    assert.equal(
      redactCapabilityUrl(
        '/m/project/asset/v1/original/file.png?disposition=inline&expires=2000000000&kid=primary&signature=secret',
      ),
      '/m/project/asset/v1/original/file.png?[signed-query-redacted]',
    )
    assert.equal(redactCapabilityUrl('/health/live'), '/health/live')
  })
})
