import { createHash } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { parseImageTransformV1 } from '@aeonic/contracts'
import sharp from 'sharp'
import { transformImage } from '../src/media/image-transformer.js'

function sampleCount(value: string | undefined): number {
  const parsed = Number(value ?? 10)
  if (!Number.isSafeInteger(parsed) || parsed < 5 || parsed > 100) {
    throw new TypeError('BENCHMARK_SAMPLES must be an integer from 5 to 100.')
  }
  return parsed
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(probability * sorted.length) - 1] as number
}

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function fixture(): Promise<Buffer> {
  const width = 4_000
  const height = 3_000
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const pixel = offset / 3
    const x = pixel % width
    const y = Math.floor(pixel / width)
    pixels[offset] = (x * 13 + y * 3) % 256
    pixels[offset + 1] = (x * 5 + y * 11) % 256
    pixels[offset + 2] = (x * 7 + y * 17) % 256
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90, chromaSubsampling: '4:2:0' })
    .toBuffer()
}

const samples = sampleCount(process.env.BENCHMARK_SAMPLES)
const source = await fixture()
const transform = parseImageTransformV1('w_1600,f_webp,q_80')
const durations: number[] = []
const hashes: string[] = []

async function run(): Promise<void> {
  const started = performance.now()
  const transformed = await transformImage(Readable.from(source), transform.plan, 'webp', {
    maxInputPixels: 20_000_000,
    maxFrames: 1,
  })
  const output = await consume(transformed.stream)
  durations.push(performance.now() - started)
  hashes.push(createHash('sha256').update(output).digest('hex'))
}

for (let index = 0; index < 2; index += 1) await run()
durations.length = 0
hashes.length = 0
for (let index = 0; index < samples; index += 1) await run()

const p50 = percentile(durations, 0.5)
const p95 = percentile(durations, 0.95)
const uniqueHashes = new Set(hashes)
process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: 'aeonic-image-transform-v1',
      measuredAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        sharp: sharp.versions.sharp,
        libvips: sharp.versions.vips,
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        memoryBytes: totalmem(),
      },
      fixture: {
        source: 'deterministic synthetic gradient JPEG',
        width: 4_000,
        height: 3_000,
        megapixels: 12,
        sourceBytes: source.byteLength,
        transform: transform.canonicalSpec,
        concurrency: 1,
        warmupRuns: 2,
        measuredRuns: samples,
      },
      milliseconds: {
        minimum: Math.round(Math.min(...durations) * 100) / 100,
        p50: Math.round(p50 * 100) / 100,
        p95: Math.round(p95 * 100) / 100,
        maximum: Math.round(Math.max(...durations) * 100) / 100,
      },
      target: { p95Milliseconds: 2_000, passed: p95 <= 2_000 },
      deterministicOutput: {
        passed: uniqueHashes.size === 1,
        sha256: hashes[0],
      },
    },
    null,
    2,
  )}\n`,
)

if (p95 > 2_000 || uniqueHashes.size !== 1) process.exitCode = 1
