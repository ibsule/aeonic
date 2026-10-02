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

function benchmarkUuid(index: number): string {
  return `00000000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`)
  return body
}

const assetCount = integer('BENCHMARK_ASSETS', 100_000, 1_000, 1_000_000)
const requestsPerSecond = integer('BENCHMARK_REQUESTS_PER_SECOND', 20, 1, 1_000)
const durationSeconds = integer('BENCHMARK_DURATION_SECONDS', 20, 1, 86_400)
const maximumP95Milliseconds = integer('BENCHMARK_P95_MILLISECONDS', 200, 1, 60_000)
const maximumRssGrowthMiB = integer('BENCHMARK_MAX_RSS_GROWTH_MIB', 128, 1, 16_384)
const port = integer('BENCHMARK_PORT', 39_017, 1_024, 65_535)
const origin = `http://127.0.0.1:${port}`
const directory = await mkdtemp(join(tmpdir(), 'aeonic-metadata-benchmark-'))
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_PATH: join(directory, 'aeonic.db'),
  LOCAL_STORAGE_PATH: join(directory, 'objects'),
  TUS_STORAGE_PATH: join(directory, 'tus'),
  BETTER_AUTH_SECRET: 'benchmark-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: origin,
  LOG_LEVEL: 'silent',
})
const database = openDatabase(config)
database.migrate()
const auth = createAuth(config, database)
const server = buildApp({ config, auth, database, logger: false }).listen(port, '127.0.0.1')

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
  const userId = String(setup.userId)
  const insertAsset = database.client.prepare(
    `insert into assets
      (id, organization_id, project_id, public_id, name, folder, media_kind, visibility,
       state, current_version, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'image', 'private', 'ready', 1, ?, ?, ?)`,
  )
  const insertVersion = database.client.prepare(
    `insert into asset_versions
      (id, organization_id, project_id, asset_id, version, state, mime_type, size_bytes,
       sha256, width, height, metadata, created_by, created_at)
     values (?, ?, ?, ?, 1, 'ready', 'image/jpeg', 1048576, ?, 1600, 900, ?, ?, ?)`,
  )
  const seed = database.client.transaction(() => {
    const createdAt = Date.now()
    for (let index = 1; index <= assetCount; index += 1) {
      const assetId = benchmarkUuid(index)
      const publicId = benchmarkUuid(assetCount + index)
      insertAsset.run(
        assetId,
        organizationId,
        projectId,
        publicId,
        `Benchmark asset ${index}`,
        `benchmark/${index % 100}`,
        userId,
        createdAt + index,
        createdAt + index,
      )
      insertVersion.run(
        benchmarkUuid(assetCount * 2 + index),
        organizationId,
        projectId,
        assetId,
        index.toString(16).padStart(64, '0'),
        JSON.stringify({ benchmark: true }),
        userId,
        createdAt + index,
      )
    }
  })
  const seedStartedAt = performance.now()
  seed()
  const seedMilliseconds = performance.now() - seedStartedAt

  const endpoint = `${origin}/api/v1/organizations/${organizationId}/projects/${projectId}/assets?limit=50`
  for (let index = 0; index < 10; index += 1) {
    const warmup = await fetch(endpoint, { headers: { cookie } })
    if (!warmup.ok) throw new Error(`Warm-up request failed with HTTP ${warmup.status}.`)
    await warmup.arrayBuffer()
  }

  const requestCount = requestsPerSecond * durationSeconds
  const intervalMilliseconds = 1_000 / requestsPerSecond
  const latencies: number[] = []
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
          const response = await fetch(endpoint, { headers: { cookie } })
          await response.arrayBuffer()
          latencies.push(performance.now() - requestStartedAt)
          if (!response.ok) failures.push(`HTTP ${response.status}`)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      })(),
    )
  }
  await Promise.all(pending)
  const elapsedSeconds = (performance.now() - startedAt) / 1_000
  const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore)
  const p95 = percentile(latencies, 0.95)
  const throughput = latencies.length / elapsedSeconds
  const minimumThroughput = requestsPerSecond * 0.95
  const passed =
    failures.length === 0 &&
    p95 <= maximumP95Milliseconds &&
    throughput >= minimumThroughput &&
    rssGrowthBytes <= maximumRssGrowthMiB * 1024 * 1024

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'aeonic-metadata-api-v1',
        measuredAt: new Date().toISOString(),
        fixture: { assets: assetCount, seedMilliseconds: Math.round(seedMilliseconds) },
        workload: { requestsPerSecond, durationSeconds, requestCount, responseItems: 50 },
        results: {
          completedRequests: latencies.length,
          failures: failures.length,
          firstFailure: failures[0] ?? null,
          measuredThroughput: Math.round(throughput * 100) / 100,
          p50Milliseconds: Math.round(percentile(latencies, 0.5) * 100) / 100,
          p95Milliseconds: Math.round(p95 * 100) / 100,
          maximumMilliseconds: Math.round(Math.max(...latencies) * 100) / 100,
          rssGrowthBytes,
        },
        targets: {
          minimumThroughput,
          maximumP95Milliseconds,
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
  database.close()
  await rm(directory, { recursive: true, force: true })
}
