import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { parseImageTransformV1 } from '@aeonic/contracts'
import sharp from 'sharp'
import {
  type ImageOutputFormat,
  ImageTransformError,
  transformImage,
} from '../src/media/image-transformer.js'

async function fixture(): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 80, channels: 3, background: '#8b5cf6' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

describe('bounded image transformer', () => {
  it('applies canonical operations, auto-orients, and strips source metadata', async () => {
    const source = await fixture()
    const plan = parseImageTransformV1('w_40,f_webp,q_75').plan
    const transformed = await transformImage(Readable.from([source]), plan, 'webp', {
      maxInputPixels: 1_000_000,
      maxFrames: 1,
    })
    const output = await consume(transformed.stream)
    const metadata = await sharp(output).metadata()

    assert.equal(transformed.mimeType, 'image/webp')
    assert.equal(transformed.extension, 'webp')
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.width, 40)
    assert.equal(metadata.height, 60)
    assert.equal(metadata.orientation, undefined)
    assert.equal(transformed.processor.name, 'sharp')
    assert.match(transformed.processor.version, /^\d+\.\d+\.\d+$/)
  })

  it('produces byte-identical output for the same plan and pinned processor', async () => {
    const source = await fixture()
    const plan = parseImageTransformV1('w_64,h_64,f_jpeg,q_82,sharpen_1.2').plan
    const render = async (): Promise<string> => {
      const transformed = await transformImage(Readable.from([source]), plan, 'jpeg', {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      })
      return createHash('sha256')
        .update(await consume(transformed.stream))
        .digest('hex')
    }
    assert.equal(await render(), await render())
  })

  it('supports every allowlisted concrete output encoder', async () => {
    const source = await fixture()
    for (const format of [
      'jpeg',
      'png',
      'webp',
      'avif',
    ] as const satisfies readonly ImageOutputFormat[]) {
      const plan = parseImageTransformV1(`w_24,f_${format}`).plan
      const transformed = await transformImage(Readable.from([source]), plan, format, {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      })
      const metadata = await sharp(await consume(transformed.stream)).metadata()
      assert.equal(metadata.format === 'heif' ? 'avif' : metadata.format, format)
    }
  })

  it('rejects format conflicts, decode limits, and pre-cancelled work', async () => {
    const source = await fixture()
    const plan = parseImageTransformV1('w_40,f_webp').plan
    await assert.rejects(
      transformImage(Readable.from([source]), plan, 'jpeg', {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      }),
      (error: unknown) =>
        error instanceof ImageTransformError && error.code === 'output_format_mismatch',
    )
    await assert.rejects(
      transformImage(Readable.from([source]), plan, 'webp', { maxInputPixels: 100, maxFrames: 1 }),
      (error: unknown) =>
        error instanceof ImageTransformError && error.code === 'image_limit_exceeded',
    )
    const cancelled = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(
      transformImage(
        Readable.from([source]),
        plan,
        'webp',
        { maxInputPixels: 1_000_000, maxFrames: 1 },
        cancelled,
      ),
      /cancelled/,
    )

    const failedSource = new Readable({
      read() {
        this.destroy(new Error('source read failed'))
      },
    })
    await assert.rejects(
      transformImage(failedSource, plan, 'webp', { maxInputPixels: 1_000_000, maxFrames: 1 }),
      /source read failed/,
    )
  })
})
