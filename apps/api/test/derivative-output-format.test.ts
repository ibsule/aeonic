import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveImageOutputFormat } from '../src/derivatives/output-format.js'

describe('image derivative output negotiation', () => {
  it('keeps explicit and supported source formats stable', () => {
    assert.equal(resolveImageOutputFormat('png', 'image/jpeg', 'image/avif'), 'png')
    assert.equal(resolveImageOutputFormat('source', 'image/jpeg', 'image/avif'), 'jpeg')
    assert.equal(resolveImageOutputFormat('source', 'image/gif', '*/*'), null)
  })

  it('prefers modern encoders for equally acceptable automatic formats', () => {
    assert.equal(
      resolveImageOutputFormat('auto', 'image/jpeg', 'image/avif,image/webp,*/*;q=0.8'),
      'avif',
    )
    assert.equal(resolveImageOutputFormat('auto', 'image/jpeg', 'image/webp,*/*;q=0.8'), 'webp')
  })

  it('honors quality, specificity, exclusions, and source fallback', () => {
    assert.equal(
      resolveImageOutputFormat(
        'auto',
        'image/png',
        'image/avif;q=0,image/webp;q=0.7,image/png;q=0.9,*/*;q=0.1',
      ),
      'png',
    )
    assert.equal(resolveImageOutputFormat('auto', 'image/jpeg'), 'jpeg')
    assert.equal(resolveImageOutputFormat('auto', 'image/gif'), 'webp')
    assert.equal(resolveImageOutputFormat('auto', 'image/jpeg', 'text/html'), null)
    assert.equal(
      resolveImageOutputFormat('auto', 'image/jpeg', 'image/avif;q=invalid,image/jpeg;q=0.8'),
      'jpeg',
    )
  })
})
