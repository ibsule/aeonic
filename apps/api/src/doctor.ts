import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { ConfigurationError, loadConfig } from './config.js'

const execute = promisify(execFile)
type CheckStatus = 'pass' | 'warn' | 'fail'
interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
}

async function toolCheck(command: string, args: string[] = ['-version']): Promise<DoctorCheck> {
  try {
    const result = await execute(command, args, { timeout: 5_000, maxBuffer: 64 * 1024 })
    const version =
      `${result.stdout}\n${result.stderr}`.trim().split('\n')[0]?.slice(0, 160) ?? 'available'
    return { name: `tool:${command}`, status: 'pass', detail: version }
  } catch {
    return {
      name: `tool:${command}`,
      status: 'fail',
      detail: `${command} is unavailable or did not respond.`,
    }
  }
}

async function writablePath(name: string, path: string): Promise<DoctorCheck> {
  try {
    const target = await stat(path)
      .then(() => path)
      .catch(() => dirname(resolve(path)))
    await access(target, constants.R_OK | constants.W_OK)
    return { name, status: 'pass', detail: `${target} is readable and writable.` }
  } catch {
    return { name, status: 'fail', detail: `${path} is not accessible to the current user.` }
  }
}

function databaseCheck(path: string): DoctorCheck {
  if (path === ':memory:')
    return {
      name: 'database',
      status: 'warn',
      detail: 'The database is in-memory and will not survive a restart.',
    }
  if (!existsSync(resolve(path))) {
    return {
      name: 'database',
      status: 'warn',
      detail: 'Database does not exist yet; it will be created on first start.',
    }
  }
  try {
    const client = new Database(resolve(path), { readonly: true, fileMustExist: true })
    client.pragma('query_only = ON')
    const result = client.pragma('quick_check', { simple: true })
    const foreignKeys = client.pragma('foreign_key_check') as unknown[]
    client.close()
    if (result !== 'ok' || foreignKeys.length > 0)
      return {
        name: 'database',
        status: 'fail',
        detail: 'SQLite integrity or foreign-key checks failed.',
      }
    return {
      name: 'database',
      status: 'pass',
      detail: 'SQLite opened read-only; integrity and foreign keys are healthy.',
    }
  } catch {
    return {
      name: 'database',
      status: 'fail',
      detail: 'SQLite could not be opened read-only.',
    }
  }
}

export async function runDoctor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = []
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(environment)
    checks.push({
      name: 'configuration',
      status: 'pass',
      detail: `Configuration is valid for ${config.environment}.`,
    })
  } catch (error) {
    checks.push({
      name: 'configuration',
      status: 'fail',
      detail:
        error instanceof ConfigurationError ? error.message : 'Configuration could not be loaded.',
    })
    return { ok: false, checks }
  }
  checks.push({
    name: 'runtime',
    status: process.versions.node.startsWith('24.') ? 'pass' : 'fail',
    detail: `Node.js ${process.versions.node}; Aeonic requires Node.js 24.`,
  })
  checks.push(databaseCheck(config.databasePath))
  checks.push(await writablePath('database-directory', config.databasePath))
  checks.push(await writablePath('upload-staging', config.tusStoragePath))
  if (config.storageBackend === 'local')
    checks.push(await writablePath('storage:local', config.localStoragePath))
  else
    checks.push({
      name: 'storage:s3',
      status: config.s3Bucket ? 'pass' : 'fail',
      detail: config.s3Bucket
        ? `S3 configuration is present for bucket ${config.s3Bucket}; no write probe was performed.`
        : 'S3 bucket configuration is missing.',
    })
  checks.push({
    name: 'tool:sharp',
    status: 'pass',
    detail: `sharp ${sharp.versions.sharp}; libvips ${sharp.versions.vips}`,
  })
  checks.push(
    ...(await Promise.all([
      toolCheck('ffmpeg'),
      toolCheck('ffprobe'),
      toolCheck('pdfinfo', ['-v']),
      toolCheck('pdftotext', ['-v']),
      toolCheck('pdftoppm', ['-v']),
      toolCheck('libreoffice', ['--version']),
    ])),
  )
  checks.push({
    name: 'ai-providers',
    status: 'pass',
    detail:
      'Optional AI capabilities do not affect core readiness; verify the AI profile separately.',
  })
  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

const result = await runDoctor()
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
else {
  for (const check of result.checks)
    process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}\n`)
  process.stdout.write(
    `\n${result.ok ? 'Aeonic is ready to start.' : 'Aeonic needs attention before startup.'}\n`,
  )
}
if (!result.ok) process.exitCode = 1
