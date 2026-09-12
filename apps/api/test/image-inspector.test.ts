import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import { ImageInspectionError, inspectImage } from '../src/media/image-inspector.js'

const limits = { maxInputPixels: 1_000_000, maxFrames: 10 }

describe('image inspection', () => {
  it('extracts bounded normalized metadata with processor provenance', async () => {
    const content = await sharp({
      create: { width: 32, height: 24, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer()

    const inspected = await inspectImage(Readable.from(content), 'image/png', limits)

    assert.equal(inspected.format, 'png')
    assert.equal(inspected.width, 32)
    assert.equal(inspected.height, 24)
    assert.equal(inspected.frames, 1)
    assert.equal(inspected.channels, 4)
    assert.equal(inspected.hasAlpha, true)
    assert.equal(inspected.processor.name, 'sharp')
    assert.match(inspected.processor.version, /^0\.35\./)
    assert.match(inspected.processor.engineVersion, /^8\./)
  })

  it('rejects decoder failures and declared media mismatches with stable codes', async () => {
    await assert.rejects(
      inspectImage(Readable.from('not an image'), 'image/png', limits),
      (error) => error instanceof ImageInspectionError && error.code === 'invalid_image',
    )
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer()
    await assert.rejects(
      inspectImage(Readable.from(jpeg), 'image/png', limits),
      (error) => error instanceof ImageInspectionError && error.code === 'image_type_mismatch',
    )
  })

  it('rejects images whose decoded dimensions exceed the pixel budget', async () => {
    const content = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer()

    await assert.rejects(
      inspectImage(Readable.from(content), 'image/png', {
        maxInputPixels: 1_000,
        maxFrames: 1,
      }),
      (error) => error instanceof ImageInspectionError && error.code === 'image_limit_exceeded',
    )
  })

  it('honors cancellation before decoder work begins', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await assert.rejects(
      inspectImage(Readable.from('unused'), 'image/png', limits, controller.signal),
      (error) => error === reason,
    )
  })
})
