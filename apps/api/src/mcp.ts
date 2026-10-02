import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { validate as isUuid } from 'uuid'
import { z } from 'zod/v4'
import { AgentPlannerService } from './agents/planner.js'
import { SqliteAgentWorkflowRepository } from './agents/repository.js'
import { AgentReadToolService } from './agents/tools.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db/database.js'
import { ProjectService } from './projects/service.js'
import type { TenantScope } from './repositories/types.js'

function requiredTenant(value: string | undefined, name: string): string {
  if (!value || !isUuid(value)) {
    throw new Error(`${name} must be a UUID for the project exposed through MCP.`)
  }
  return value
}

export function createAeonicMcpServer(
  tools: AgentReadToolService,
  scope: TenantScope,
  approvalTools?: { planner: AgentPlannerService; actorId: string },
): McpServer {
  const server = new McpServer(
    { name: 'aeonic', version: '1.0.0-rc.2' },
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
  if (approvalTools) {
    server.registerTool(
      'aeonic_request_asset_metadata_update',
      {
        title: 'Request approval for an asset metadata update',
        description:
          'Freeze an exact asset metadata update plan for human review. This tool never changes the asset and never grants its own approval.',
        inputSchema: z
          .object({
            assetId: z.uuid(),
            name: z.string().trim().min(1).max(200).optional(),
            folder: z.string().trim().max(500).optional(),
            visibility: z.enum(['private', 'public']).optional(),
            reason: z.string().trim().min(1).max(1_000),
            idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
          })
          .refine(
            (input) =>
              input.name !== undefined ||
              input.folder !== undefined ||
              input.visibility !== undefined,
            { message: 'At least one metadata change is required.' },
          ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        const frozen = approvalTools.planner.requestAssetMetadataUpdate(
          approvalTools.actorId,
          scope,
          {
            assetId: input.assetId,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.folder === undefined ? {} : { folder: input.folder }),
            ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          },
          `mcp:${input.idempotencyKey}`,
        )
        const output = {
          status: 'human_approval_required',
          mutationExecuted: false,
          approvalId: frozen.approval.id,
          planId: frozen.plan.id,
          planHash: frozen.plan.planHash,
          summary: frozen.plan.summary,
          riskClass: frozen.plan.riskClass,
          reversibility: frozen.plan.reversibility,
          requiredRole: frozen.plan.requiredRole,
          calls: frozen.plan.toolCalls,
          targets: frozen.plan.targetSnapshot,
          expiresAt: frozen.approval.expiresAt.toISOString(),
        }
        return {
          content: [
            {
              type: 'text',
              text: `No mutation was executed. Human approval is required.\n${JSON.stringify(output)}`,
            },
          ],
          structuredContent: output,
        }
      },
    )
  }
  return server
}

export function startMcpServer(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(environment)
  const database = openDatabase(config)
  const scope = {
    organizationId: requiredTenant(environment.MCP_ORGANIZATION_ID, 'MCP_ORGANIZATION_ID'),
    projectId: requiredTenant(environment.MCP_PROJECT_ID, 'MCP_PROJECT_ID'),
  }
  const approvalTools =
    environment.MCP_APPROVAL_TOOLS_ENABLED === 'true'
      ? {
          planner: new AgentPlannerService(
            database,
            new SqliteAgentWorkflowRepository(database),
            new ProjectService(database),
          ),
          actorId: requiredTenant(environment.MCP_ACTOR_USER_ID, 'MCP_ACTOR_USER_ID'),
        }
      : undefined
  const handle = serveStdio(
    () => createAeonicMcpServer(new AgentReadToolService(database), scope, approvalTools),
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
