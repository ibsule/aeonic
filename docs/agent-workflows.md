# Approval-gated media workflows

Aeonic's workflow-agent surface is deliberately narrower than its human API. Agents can inspect a
configured project and request a frozen metadata-change plan. They cannot approve their own plan or
mutate an asset directly.

## Safety model

Every mutation follows one durable path:

1. Aeonic authorizes the requesting user and resolves the exact current asset version.
2. A deterministic policy checks a closed tool allowlist and fixed step, asset, output, retry, time,
   token, and cost budgets.
3. Aeonic freezes the tool arguments, target version and timestamp, expected effect, risk,
   reversibility, and required role into an immutable SHA-256-addressed plan.
4. An owner or administrator reviews that exact plan in the dashboard and records a decision.
5. A separate explicit action consumes the approval once and queues the frozen call.
6. The worker revalidates the plan hash, approval, arguments, budget, tenant, and target snapshot in
   the same transaction that applies the change.

Changed targets, expired approvals, reused hashes, unknown tools, exceeded budgets, and repeated
execution attempts fail closed. Cancellation revokes non-terminal queued or leased work. Audit
events connect the request, plan, approval, execution, and resulting asset change.

The first mutation tool is intentionally small: `assets.update_metadata` updates one exact asset's
name, folder, or visibility. More tools should be added only with a dedicated policy, preview,
compensation decision, and adversarial tests.

## MCP server

Build the workspace, then configure a client to launch the stdio server:

```bash
pnpm build
MCP_ORGANIZATION_ID=ORGANIZATION_UUID \
MCP_PROJECT_ID=PROJECT_UUID \
pnpm --filter @aeonic/api start:mcp
```

The default server advertises only `aeonic_assets_list` and `aeonic_assets_get`. Results are bounded,
project-scoped, and omit storage identities and creator details.

To let the connected client request a human-reviewed plan, explicitly opt in and bind the server to
an existing owner or administrator:

```bash
MCP_ORGANIZATION_ID=ORGANIZATION_UUID \
MCP_PROJECT_ID=PROJECT_UUID \
MCP_APPROVAL_TOOLS_ENABLED=true \
MCP_ACTOR_USER_ID=USER_UUID \
pnpm --filter @aeonic/api start:mcp
```

This adds `aeonic_request_asset_metadata_update`. Each call requires a caller-generated idempotency
key and returns the immutable plan hash, exact targets, effects, risk, role, and expiry. The tool's
response always reports `mutationExecuted: false`; a human must use Aeonic's approval inbox.

Treat the MCP process configuration as a privileged local credential. Give each client the smallest
project scope it needs, keep approval-request tools disabled unless required, and do not expose the
stdio server as an unauthenticated network service. Prompt text and asset metadata are untrusted
data; neither is interpreted as a tool name or policy instruction.

For Compose deployments, an MCP client can use the same built API image and persistent database by
launching a one-off `api` container with the four variables above and the command
`node apps/api/dist/mcp.js`. Keep stdin attached because MCP uses stdio.
