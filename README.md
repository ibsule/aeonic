# Aeonic

Aeonic is an open-source, self-hosted media platform in active development. The intended product
will provide storage, transformation, delivery, and optional media intelligence for individual
developers and small teams.

## Current status

*Version 0.2* provides the trustworthy API foundation, and Phase 2 control-plane work is underway.
It currently ships:

- A Node.js 24 and strict TypeScript 6 workspace.
- A contract-validated Express 5 API.
- Validated environment configuration.
- Structured JSON logging with credential redaction.
- Separate liveness and readiness endpoints.
- RFC 9457-compatible error responses.
- Automated lint, format, type, test, and build checks.
- SQLite persistence with reviewed Drizzle migrations and WAL-mode safety controls.
- Better Auth email/password sessions, organization roles, and organization-owned API-key support.
- A race-safe initial setup endpoint that atomically creates the first owner, organization, project,
  and audit event.
- Tenant-isolated project, membership, project API-key, and audit APIs.
- OpenAPI 3.1 JSON at `/openapi.json` and an interactive reference at `/docs`.

Uploads, asset delivery, transformations, the dashboard, Docker Compose, and AI features are **not
implemented yet**. Phase 2 migration rehearsal and completion verification remain in progress.
Earlier experimental routes were removed because they did not meet the project's security or
reliability requirements.

## Requirements

- Node.js 24 LTS
- pnpm 11.25.0 through Corepack

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

The API listens on `http://localhost:3001` by default.

```bash
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
curl http://localhost:3001/api/v1/setup
```

Open <http://localhost:3001/docs> for the interactive API reference, or consume the machine-readable
document at <http://localhost:3001/openapi.json>.

Use [`.env.example`](./.env.example) as the configuration reference. Environment variables can be
provided by your shell or process supervisor; automatic `.env` file loading is not currently part
of the runtime.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Build workspace dependencies and run development watchers |
| `pnpm build` | Produce clean ESM output for every package |
| `pnpm --filter @aeonic/api db:migrate` | Apply checked-in database migrations |
| `pnpm --filter @aeonic/api auth:schema` | Regenerate the Better Auth Drizzle schema |
| `pnpm --filter @aeonic/api db:generate` | Generate a reviewed migration after schema changes |
| `pnpm test` | Run the test suite |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm lint` | Run static analysis |
| `pnpm format:check` | Verify formatting |
| `pnpm check` | Run the complete local/CI quality gate |

## Repository layout

```text
apps/
  api/                 Express control-plane API
packages/
  contracts/           Transport schemas and shared public types
scripts/               Repository maintenance scripts
```

Architecture research and internal planning are maintained separately from this source repository.
User-facing documentation will expand only as corresponding behavior ships.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues should follow
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
