import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { before, describe, it } from 'node:test'
import sharp from 'sharp'
import { runMediaCommand } from '../src/media/subprocess.js'
import {
  createVideoDerivative,
  createVideoPoster,
  inspectVideo,
} from '../src/media/video-processor.js'

let fixture: Buffer

before(async () => {
  const generated = await runMediaCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=12',
      '-t',
      '1',
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
    { timeoutMs: 10_000, maxStdoutBytes: 2_000_000, maxStderrBytes: 100_000 },
  )
  fixture = generated.stdout
})

const limits = {
  maxInputBytes: 2_000_000,
  maxOutputBytes: 2_000_000,
  maxDurationSeconds: 10,
  maxWidth: 1920,
  maxHeight: 1080,
  timeoutMs: 20_000,
}

describe('bounded video processor', () => {
  it('inspects streams and rejects duration limits', async () => {
    const inspected = await inspectVideo(Readable.from(fixture), 'video/mp4', limits)
    assert.equal(inspected.width, 160)
    assert.equal(inspected.height, 90)
    assert.equal(inspected.videoCodec, 'h264')
    assert.ok(inspected.durationSeconds >= 1)
    await assert.rejects(
      inspectVideo(Readable.from(fixture), 'video/mp4', {
        ...limits,
        maxDurationSeconds: 0.5,
      }),
      /exceeds configured limits/,
    )
  })

  it('creates bounded posters and enumerated MP4/WebM transcodes', async () => {
    const poster = await createVideoPoster(Readable.from(fixture), 'video/mp4', limits, {
      width: 80,
    })
    assert.equal((await sharp(poster).metadata()).width, 80)
    for (const preset of ['mp4-720p', 'webm-720p'] as const) {
      const output = await createVideoDerivative(
        Readable.from(fixture),
        'video/mp4',
        preset,
        limits,
        { clipSeconds: 0.5 },
      )
      assert.ok(output.content.byteLength > 0)
      const inspected = await inspectVideo(Readable.from(output.content), output.mimeType, limits)
      assert.ok(['h264', 'vp9'].includes(inspected.videoCodec))
    }
  })
})
