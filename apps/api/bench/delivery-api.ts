import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '../src/app.js'
import { createAuth } from '../src/auth/auth.js'
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { createStorageRuntime } from '../src/storage/factory.js'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(probability * sorted.length) - 1] as number
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`)
  return body
}

const requestsPerSecond = integer('BENCHMARK_REQUESTS_PER_SECOND', 100, 1, 1_000)
const durationSeconds = integer('BENCHMARK_DURATION_SECONDS', 20, 1, 86_400)
const maximumP95TtfbMilliseconds = integer('BENCHMARK_P95_TTFB_MILLISECONDS', 100, 1, 60_000)
const maximumRssGrowthMiB = integer('BENCHMARK_MAX_RSS_GROWTH_MIB', 128, 1, 16_384)
const port = integer('BENCHMARK_PORT', 39_018, 1_024, 65_535)
const origin = `http://127.0.0.1:${port}`
const directory = await mkdtemp(join(tmpdir(), 'aeonic-delivery-benchmark-'))
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_PATH: join(directory, 'aeonic.db'),
  LOCAL_STORAGE_PATH: join(directory, 'objects'),
  TUS_STORAGE_PATH: join(directory, 'tus'),
  BETTER_AUTH_SECRET: 'benchmark-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: origin,
  DELIVERY_BASE_URL: origin,
  DELIVERY_SIGNING_KEYS: `benchmark:${Buffer.alloc(32, 7).toString('base64url')}`,
  LOG_LEVEL: 'silent',
})
const database = openDatabase(config)
database.migrate()
const auth = createAuth(config, database)
const storage = createStorageRuntime(config)
const server = buildApp({ config, auth, database, storage, logger: false }).listen(
  port,
  '127.0.0.1',
)

try {
  await once(server, 'listening')
  const setup = await json(
    await fetch(`${origin}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        name: 'Benchmark Owner',
        email: 'benchmark@localhost.test',
        password: 'benchmark-password-long-enough',
        organizationName: 'Benchmark Studio',
        organizationSlug: 'benchmark-studio',
        projectName: 'Benchmark Library',
        projectSlug: 'benchmark-library',
      }),
    }),
  )
  const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      email: 'benchmark@localhost.test',
      password: 'benchmark-password-long-enough',
    }),
  })
  await json(signIn)
  const cookie = signIn.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('The benchmark sign-in did not return a session cookie.')

  const organizationId = String(setup.organizationId)
  const projectId = String(setup.projectId)
  const fixture = Buffer.alloc(1024 * 1024)
  tinyPng.copy(fixture)
  const uploaded = await json(
    await fetch(
      `${origin}/api/v1/organizations/${organizationId}/projects/${projectId}/uploads?filename=benchmark.png&visibility=public`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'image/png', 'content-length': String(fixture.length) },
        body: fixture,
      },
    ),
  )
  const assetId = String(uploaded.assetId)
  const publicId = String(uploaded.publicId)
  database.client.prepare("update assets set state = 'ready' where id = ?").run(assetId)
  database.client
    .prepare("update asset_versions set state = 'ready' where asset_id = ?")
    .run(assetId)

  const endpoint = `${origin}/m/${projectId}/${publicId}/v1/original/benchmark.png`
  for (let index = 0; index < 10; index += 1) {
    const warmup = await fetch(endpoint)
    if (!warmup.ok) throw new Error(`Warm-up request failed with HTTP ${warmup.status}.`)
    if ((await warmup.arrayBuffer()).byteLength !== fixture.length) {
      throw new Error('Warm-up response did not contain the complete fixture.')
    }
  }

  const requestCount = requestsPerSecond * durationSeconds
  const intervalMilliseconds = 1_000 / requestsPerSecond
  const ttfb: number[] = []
  const responseLatency: number[] = []
  const failures: string[] = []
  const rssBefore = process.memoryUsage().rss
  const startedAt = performance.now()
  const pending: Promise<void>[] = []

  for (let index = 0; index < requestCount; index += 1) {
    const scheduledAt = startedAt + index * intervalMilliseconds
    const wait = scheduledAt - performance.now()
    if (wait > 0) await delay(wait)
    pending.push(
      (async () => {
        const requestStartedAt = performance.now()
        try {
          const response = await fetch(endpoint)
          ttfb.push(performance.now() - requestStartedAt)
          const bytes = (await response.arrayBuffer()).byteLength
          responseLatency.push(performance.now() - requestStartedAt)
          if (!response.ok) failures.push(`HTTP ${response.status}`)
          else if (bytes !== fixture.length)
            failures.push(`Expected ${fixture.length} bytes; got ${bytes}`)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      })(),
    )
  }
  await Promise.all(pending)
  const elapsedSeconds = (performance.now() - startedAt) / 1_000
  const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore)
  const p95Ttfb = percentile(ttfb, 0.95)
  const throughput = responseLatency.length / elapsedSeconds
  const minimumThroughput = requestsPerSecond * 0.95
  const passed =
    failures.length === 0 &&
    p95Ttfb <= maximumP95TtfbMilliseconds &&
    throughput >= minimumThroughput &&
    rssGrowthBytes <= maximumRssGrowthMiB * 1024 * 1024

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'aeonic-local-delivery-v1',
        measuredAt: new Date().toISOString(),
        fixture: { bytes: fixture.length, visibility: 'public', storage: 'local' },
        workload: { requestsPerSecond, durationSeconds, requestCount },
        results: {
          completedRequests: responseLatency.length,
          failures: failures.length,
          firstFailure: failures[0] ?? null,
          measuredThroughput: Math.round(throughput * 100) / 100,
          p50TtfbMilliseconds: Math.round(percentile(ttfb, 0.5) * 100) / 100,
          p95TtfbMilliseconds: Math.round(p95Ttfb * 100) / 100,
          p95ResponseMilliseconds: Math.round(percentile(responseLatency, 0.95) * 100) / 100,
          maximumResponseMilliseconds: Math.round(Math.max(...responseLatency) * 100) / 100,
          rssGrowthBytes,
        },
        targets: {
          minimumThroughput,
          maximumP95TtfbMilliseconds,
          maximumRssGrowthBytes: maximumRssGrowthMiB * 1024 * 1024,
          passed,
        },
      },
      null,
      2,
    )}\n`,
  )
  if (!passed) process.exitCode = 1
} finally {
  server.close()
  await once(server, 'close')
  storage.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
}
