import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createOriginalDeliveryPath, DeliverySigner } from '../src/delivery/signing.js'

const primary = Buffer.alloc(32, 1).toString('base64url')
const previous = Buffer.alloc(32, 2).toString('base64url')

describe('delivery URL signing', () => {
  it('signs canonical paths and verifies method-independent capabilities', () => {
    const signer = new DeliverySigner([
      { id: 'current', secret: primary },
      { id: 'previous', secret: previous },
    ])
    const path = createOriginalDeliveryPath({
      projectId: '019cc836-950f-7f99-88e0-b718f1c86e6a',
      publicId: '019cc836-a354-7ed3-911d-6aed9bfac20d',
      version: 2,
      filename: 'résumé final.pdf',
    })
    const signature = signer.create(path, 2_000_000_000, 'attachment')

    assert.equal(signature.keyId, 'current')
    assert.match(path, /r%C3%A9sum%C3%A9%20final\.pdf$/)
    assert.equal(
      signer.verify({ ...signature, path, disposition: 'attachment' }, new Date(1_900_000_000_000)),
      true,
    )
  })

  it('supports key rotation and rejects changed, expired, and malformed claims', () => {
    const oldSigner = new DeliverySigner([{ id: 'previous', secret: previous }])
    const rotatedSigner = new DeliverySigner([
      { id: 'current', secret: primary },
      { id: 'previous', secret: previous },
    ])
    const path = '/m/project/asset/v1/original/photo.jpg'
    const oldSignature = oldSigner.create(path, 2_000_000_000, 'inline')
    const now = new Date(1_900_000_000_000)

    assert.equal(rotatedSigner.verify({ ...oldSignature, path, disposition: 'inline' }, now), true)
    assert.equal(
      rotatedSigner.verify({ ...oldSignature, path: `${path}.exe`, disposition: 'inline' }, now),
      false,
    )
    assert.equal(
      rotatedSigner.verify({ ...oldSignature, path, disposition: 'attachment' }, now),
      false,
    )
    assert.equal(
      rotatedSigner.verify(
        { ...oldSignature, path, disposition: 'inline' },
        new Date(2_100_000_000_000),
      ),
      false,
    )
    assert.equal(
      rotatedSigner.verify(
        { ...oldSignature, signature: 'invalid', path, disposition: 'inline' },
        now,
      ),
      false,
    )
  })
})
