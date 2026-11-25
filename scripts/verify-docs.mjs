import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await markdownFiles(location)))
    else if (entry.name.endsWith('.md')) files.push(location)
  }
  return files
}

function relative(filename) {
  return path.relative(root, filename).split(path.sep).join('/')
}

function shellBlocks(content) {
  const blocks = []
  const pattern = /^```(?:bash|sh|shell)\s*\n([\s\S]*?)^```\s*$/gm
  for (const match of content.matchAll(pattern)) blocks.push(match[1])
  return blocks
}

function declaredEnvironment(content) {
  return new Set(
    content
      .split('\n')
      .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean),
  )
}

const files = await markdownFiles(root)
const markdown = new Map()
for (const filename of files) {
  const content = await readFile(filename, 'utf8')
  markdown.set(filename, content)
  const fenceCount = (content.match(/^```/gm) ?? []).length
  if (fenceCount % 2 !== 0) errors.push(`${relative(filename)} has an unclosed code fence.`)

  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim()
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const pathname = decodeURIComponent(target.split('#')[0])
    const resolved = path.resolve(path.dirname(filename), pathname)
    try {
      const details = await stat(resolved)
      if (!details.isFile()) errors.push(`${relative(filename)} links to non-file ${target}.`)
    } catch {
      errors.push(`${relative(filename)} has a broken local link: ${target}.`)
    }
  }

  for (const [index, block] of shellBlocks(content).entries()) {
    const result = spawnSync('bash', ['-n', '-c', block], {
      encoding: 'utf8',
      timeout: 2_000,
    })
    if (result.status !== 0) {
      errors.push(
        `${relative(filename)} shell block ${index + 1} is invalid: ${result.error?.message ?? result.stderr.trim()}`,
      )
    }
  }
}

const envExample = await readFile(path.join(root, '.env.example'), 'utf8')
const composeExample = await readFile(path.join(root, '.env.compose.example'), 'utf8')
const knownEnvironment = new Set([
  ...declaredEnvironment(envExample),
  ...declaredEnvironment(composeExample),
])
const configuration = await readFile(path.join(root, 'docs/configuration.md'), 'utf8')
for (const match of configuration.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
  if (!knownEnvironment.has(match[1])) {
    errors.push(`docs/configuration.md documents unknown environment variable ${match[1]}.`)
  }
}

const authentication = await readFile(path.join(root, 'docs/authentication.md'), 'utf8')
const scopes = await readFile(path.join(root, 'packages/contracts/src/api-keys.ts'), 'utf8')
for (const scope of [
  'projects:read',
  'assets:read',
  'assets:write',
  'assets:delete',
  'jobs:read',
]) {
  if (!authentication.includes(`\`${scope}\``) || !scopes.includes(`'${scope}'`)) {
    errors.push(`API-key scope ${scope} is not synchronized between docs and contracts.`)
  }
}
const policy = await readFile(path.join(root, 'apps/api/src/authorization/policy.ts'), 'utf8')
for (const role of ['owner', 'admin', 'developer', 'viewer']) {
  if (!authentication.toLowerCase().includes(role) || !policy.includes(role)) {
    errors.push(`Role ${role} is not synchronized between docs and policy.`)
  }
}

const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8')
const composeServices = ['edge', 'api', 'worker', 'qdrant', 'ai-worker']
for (const service of composeServices) {
  const declaration = `${service}:`
  if (!compose.includes(`  ${declaration}`))
    errors.push(`compose.yaml is missing documented service ${service}.`)
}
for (const command of ['dist/doctor.js', 'docker compose config --quiet', 'docker compose ps']) {
  if (![...markdown.values()].some((content) => content.includes(command))) {
    errors.push(`Required operator instruction is not documented: ${command}.`)
  }
}

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const workspacePackages = new Map()
for (const manifest of [
  'apps/api/package.json',
  'apps/dashboard/package.json',
  'packages/contracts/package.json',
]) {
  const parsed = JSON.parse(await readFile(path.join(root, manifest), 'utf8'))
  workspacePackages.set(parsed.name, parsed)
}
const pnpmBuiltins = new Set([
  'add',
  'audit',
  'deploy',
  'dlx',
  'exec',
  'install',
  'list',
  'rebuild',
  'remove',
  'run',
  'update',
  'why',
])
for (const [filename, content] of markdown) {
  for (const block of shellBlocks(content)) {
    for (const match of block.matchAll(/\bpnpm\s+(?:--filter\s+(\S+)\s+)?([a-z][a-z0-9:-]*)/g)) {
      const filter = match[1]?.replace(/\.\.\.$/, '')
      const command = match[2]
      if (pnpmBuiltins.has(command)) continue
      const manifest = filter ? workspacePackages.get(filter) : rootPackage
      if (!manifest) {
        errors.push(`${relative(filename)} uses unknown pnpm workspace filter ${filter}.`)
      } else if (!Object.hasOwn(manifest.scripts ?? {}, command)) {
        errors.push(
          `${relative(filename)} uses missing ${filter ?? 'root'} package script ${command}.`,
        )
      }
    }
  }
}

const documentedComposeServices = new Set()
for (const content of markdown.values()) {
  for (const match of content.matchAll(
    /docker compose (?:cp|logs|run|stop)[^\n\\]*(?:\\\n[^\n]*)*/g,
  )) {
    for (const service of composeServices) {
      if (new RegExp(`(?:^|[\\s])${service}(?=[:\\s]|$)`).test(match[0])) {
        documentedComposeServices.add(service)
      }
    }
  }
}
for (const service of documentedComposeServices) {
  if (!compose.includes(`  ${service}:`)) {
    errors.push(`Documentation uses missing Compose service ${service}.`)
  }
}

const gettingStarted = await readFile(path.join(root, 'docs/getting-started.md'), 'utf8')
const canonicalRepository = 'https://github.com/ibsule/aeonic.git'
if (!gettingStarted.includes(`git clone ${canonicalRepository}`)) {
  errors.push(`docs/getting-started.md does not use the canonical repository URL.`)
}
const upgrade = await readFile(path.join(root, 'docs/upgrade.md'), 'utf8')
if (!upgrade.includes(`git checkout v${rootPackage.version}`)) {
  errors.push(`docs/upgrade.md does not target v${rootPackage.version}.`)
}
for (const source of ['apps/api/src/doctor.ts', 'apps/api/src/mcp.ts']) {
  try {
    const details = await stat(path.join(root, source))
    if (!details.isFile()) errors.push(`Documented runtime entry point is not a file: ${source}.`)
  } catch {
    errors.push(`Documentation references a runtime entry point without source: ${source}.`)
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`FAIL ${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Documentation verified: ${files.length} Markdown files, local links, shell syntax, pnpm scripts, Compose services, release version, repository URL, configuration names, roles, scopes, and runtime entry points.\n`,
  )
}
