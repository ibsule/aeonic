import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  contentDisposition,
  InvalidRangeError,
  ifModifiedSinceMatches,
  ifNoneMatchMatches,
  ifRangeAllows,
  parseSingleByteRange,
} from '../src/delivery/http.js'

describe('delivery HTTP semantics', () => {
  it('parses bounded, open-ended, and suffix byte ranges', () => {
    assert.deepEqual(parseSingleByteRange('bytes=2-5', 10), { start: 2, end: 5 })
    assert.deepEqual(parseSingleByteRange('bytes=8-', 10), { start: 8, end: 9 })
    assert.deepEqual(parseSingleByteRange('bytes=-3', 10), { start: 7, end: 9 })
    assert.deepEqual(parseSingleByteRange('bytes=-20', 10), { start: 0, end: 9 })
    assert.deepEqual(parseSingleByteRange('bytes=2-99', 10), { start: 2, end: 9 })
  })

  it('rejects malformed, unsafe multi-range, and unsatisfiable requests', () => {
    for (const value of [
      'items=0-1',
      'bytes=',
      'bytes=4-2',
      'bytes=10-',
      'bytes=-0',
      'bytes=0-1,4-5',
    ]) {
      assert.throws(() => parseSingleByteRange(value, 10), InvalidRangeError)
    }
  })

  it('uses weak comparison for If-None-Match and strong comparison for If-Range', () => {
    const etag = '"abc123"'
    assert.equal(ifNoneMatchMatches('W/"abc123", "other"', etag), true)
    assert.equal(ifNoneMatchMatches('*', etag), true)
    assert.equal(ifRangeAllows('W/"abc123"', etag, new Date()), false)
    assert.equal(ifRangeAllows(etag, etag, new Date()), true)
  })

  it('compares HTTP dates at whole-second precision', () => {
    const modified = new Date('2026-09-11T12:00:00.900Z')
    assert.equal(ifModifiedSinceMatches('Thu, 11 Sep 2026 12:00:00 GMT', modified), true)
    assert.equal(ifModifiedSinceMatches('Thu, 11 Sep 2026 11:59:59 GMT', modified), false)
    assert.equal(ifModifiedSinceMatches('invalid', modified), false)
  })

  it('encodes Unicode and quoted filenames without allowing header injection', () => {
    assert.equal(
      contentDisposition('attachment', 'résumé "final".pdf'),
      'attachment; filename="r_sum_ \\"final\\".pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%22final%22.pdf',
    )
  })
})
