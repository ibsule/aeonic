import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const parsePackage = async (path) => JSON.parse(await read(path))
const requiredDocuments = [
  'CHANGELOG.md',
  'docs/api-stability.md',
  'docs/deployment.md',
  'docs/performance.md',
  'docs/release-checklist.md',
  'docs/security-verification.md',
  'docs/support-matrix.md',
  'docs/upgrade.md',
  'SECURITY.md',
]

const packages = await Promise.all(
  [
    'package.json',
    'apps/api/package.json',
    'apps/dashboard/package.json',
    'packages/contracts/package.json',
  ].map(async (path) => ({ path, value: await parsePackage(path) })),
)
const expectedVersion = packages[0].value.version
const errors = []

for (const item of packages) {
  if (item.value.version !== expectedVersion) {
    errors.push(`${item.path} has version ${item.value.version}; expected ${expectedVersion}.`)
  }
}

const compose = await read('compose.yaml')
for (const expected of [
  `image: aeonic-api:${expectedVersion}`,
  `image: aeonic-worker:${expectedVersion}`,
  `image: aeonic-edge:${expectedVersion}`,
  `AEONIC_VERSION: ${expectedVersion}`,
]) {
  if (!compose.includes(expected)) errors.push(`compose.yaml is missing ${expected}.`)
}

const config = await read('apps/api/src/config.ts')
if (!config.includes(`AEONIC_VERSION: z.string().trim().min(1).default('${expectedVersion}')`)) {
  errors.push('The API default version does not match package.json.')
}
const mcp = await read('apps/api/src/mcp.ts')
if (!mcp.includes(`{ name: 'aeonic', version: '${expectedVersion}' }`)) {
  errors.push('The MCP server version does not match package.json.')
}

const readme = await read('README.md')
const releaseLine = `*Version ${expectedVersion}*`
if (!readme.includes(releaseLine)) {
  errors.push(`README.md is missing the current release line ${releaseLine}.`)
}

for (const path of requiredDocuments) {
  try {
    const content = await read(path)
    if (content.trim().length === 0) errors.push(`${path} is empty.`)
  } catch {
    errors.push(`${path} is missing.`)
  }
}

const workflowDirectory = new URL('.github/workflows/', root)
for (const filename of await readdir(workflowDirectory)) {
  if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue
  const workflow = await read(join('.github/workflows', filename))
  for (const [lineIndex, line] of workflow.split('\n').entries()) {
    const reference = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/)?.[1]
    if (reference?.startsWith('./')) continue
    if (reference && !/@[0-9a-f]{40}$/.test(reference)) {
      errors.push(`${filename}:${lineIndex + 1} does not pin ${reference} to a commit SHA.`)
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`FAIL ${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`Release metadata is consistent for ${expectedVersion}.\n`)
}
