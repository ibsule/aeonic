import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { before, describe, it } from 'node:test'
import sharp from 'sharp'
import { inspectPdf } from '../src/media/document-processor.js'
import { ImageInspectionError, inspectImage } from '../src/media/image-inspector.js'
import { MediaCommandError } from '../src/media/subprocess.js'
import { runMediaCommand } from '../src/media/subprocess.js'
import { inspectVideo } from '../src/media/video-processor.js'

let boundedVideo: Buffer

before(async () => {
  boundedVideo = (
    await runMediaCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=size=128x96:rate=10:color=red',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { timeoutMs: 10_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 100_000 },
    )
  ).stdout
})

function pdfFixture(pages: number, width: number, height: number): Buffer {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] >>`,
    ),
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

describe('media processing security corpus', () => {
  it('rejects corrupt, truncated, and oversized-pixel images before processing', async () => {
    await assert.rejects(
      inspectImage(Readable.from(Buffer.from('not an image')), 'image/png', {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      }),
      (error: unknown) => error instanceof ImageInspectionError && error.code === 'invalid_image',
    )

    const valid = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer()
    await assert.rejects(
      inspectImage(Readable.from(valid.subarray(0, 24)), 'image/png', {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      }),
      ImageInspectionError,
    )

    const compressedLargeImage = await sharp({
      create: { width: 2_048, height: 2_048, channels: 3, background: 'black' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer()
    await assert.rejects(
      inspectImage(Readable.from(compressedLargeImage), 'image/png', {
        maxInputPixels: 1_000_000,
        maxFrames: 1,
      }),
      (error: unknown) =>
        error instanceof ImageInspectionError && error.code === 'image_limit_exceeded',
    )
  })

  it('rejects videos that exceed byte, geometry, or duration ceilings', async () => {
    const base = {
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxDurationSeconds: 10,
      maxWidth: 1_920,
      maxHeight: 1_080,
      timeoutMs: 10_000,
    }
    await assert.rejects(
      inspectVideo(Readable.from(boundedVideo), 'video/mp4', {
        ...base,
        maxInputBytes: 32,
      }),
      /byte limit/,
    )
    await assert.rejects(
      inspectVideo(Readable.from(boundedVideo), 'video/mp4', { ...base, maxWidth: 64 }),
      RangeError,
    )
    await assert.rejects(
      inspectVideo(Readable.from(boundedVideo), 'video/mp4', {
        ...base,
        maxDurationSeconds: 1,
      }),
      RangeError,
    )
  })

  it('rejects excessive and malformed PDFs without rendering them', async () => {
    const limits = {
      maxInputBytes: 1_000_000,
      maxOutputBytes: 1_000_000,
      maxPages: 2,
      maxPagePoints: 2_000,
      maxTextBytes: 100_000,
      timeoutMs: 10_000,
    }
    await assert.rejects(inspectPdf(Readable.from(pdfFixture(3, 200, 100)), limits), RangeError)
    await assert.rejects(
      inspectPdf(Readable.from(pdfFixture(1, 20_000, 20_000)), limits),
      RangeError,
    )
    await assert.rejects(
      inspectPdf(Readable.from(Buffer.from('%PDF-1.4\ntruncated')), limits),
      MediaCommandError,
    )
  })
})
