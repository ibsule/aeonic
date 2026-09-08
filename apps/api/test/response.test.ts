import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { serviceStatusSchema } from '@aeonic/contracts'
import { assertResponseMatches, ResponseContractError } from '../src/http/response.js'

describe('response contracts', () => {
  it('accepts a response that matches the shared schema', () => {
    assert.doesNotThrow(() =>
      assertResponseMatches(serviceStatusSchema, {
        status: 'ok',
        version: 'test',
        timestamp: new Date().toISOString(),
      }),
    )
  })

  it('rejects an invalid response before it is sent', () => {
    assert.throws(
      () => assertResponseMatches(serviceStatusSchema, { status: 'ok' }),
      ResponseContractError,
    )
  })
})
