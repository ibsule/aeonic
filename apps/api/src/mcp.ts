import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { validate as isUuid } from 'uuid'
import { z } from 'zod/v4'
import { AgentReadToolService } from './agents/tools.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db/database.js'

function requiredTenant(value: string | undefined, name: string): string {
  if (!value || !isUuid(value)) {
    throw new Error(`${name} must be a UUID for the project exposed through MCP.`)
  }
  return value
}

export function createAeonicMcpServer(
  tools: AgentReadToolService,
  scope: { organizationId: string; projectId: string },
): McpServer {
  const server = new McpServer(
    { name: 'aeonic', version: '0.8.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool(
    'aeonic_assets_list',
    {
      title: 'List Aeonic assets',
      description:
        'List a bounded set of media assets from the one Aeonic project configured for this server.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        mediaKind: z.enum(['image', 'video', 'document']).optional(),
        state: z
          .enum([
            'uploading',
            'validating',
            'processing',
            'ready',
            'replacing',
            'deleting',
            'deleted',
            'rejected',
            'failed',
          ])
          .optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = tools.execute(scope, 'assets.list', input)
      const output = { items: result.data }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
  server.registerTool(
    'aeonic_assets_get',
    {
      title: 'Get one Aeonic asset',
      description:
        'Read safe metadata and the current version for one exact asset in the configured project.',
      inputSchema: z.object({ assetId: z.uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = tools.execute(scope, 'assets.get', input)
      const output = { result: result.data }
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      }
    },
  )
  return server
}

export function startMcpServer(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(environment)
  const database = openDatabase(config)
  const scope = {
    organizationId: requiredTenant(environment.MCP_ORGANIZATION_ID, 'MCP_ORGANIZATION_ID'),
    projectId: requiredTenant(environment.MCP_PROJECT_ID, 'MCP_PROJECT_ID'),
  }
  const handle = serveStdio(
    () => createAeonicMcpServer(new AgentReadToolService(database), scope),
    {
      onerror: (error) => console.error('Aeonic MCP error:', error.message),
    },
  )
  const close = async () => {
    await handle.close()
    database.close()
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
  return handle
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startMcpServer()
}
