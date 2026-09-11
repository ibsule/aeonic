# Aeonic

Aeonic is an open-source, self-hosted media platform in active development. The intended product
will provide storage, transformation, delivery, and optional media intelligence for individual
developers and small teams.

## Current status

*Version 0.4 (in development)* provides the trustworthy API foundation, identity/control plane,
and the first Phase 3 media-ingestion path. It currently
ships:

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
- Tenant-scoped local and S3-compatible storage engines with immutable streaming writes.
- Streaming simple uploads with size limits, project quota reservations, optional SHA-256 checks,
  MIME/extension/signature validation, idempotent replay, and interrupted-upload reconciliation.
- OpenAPI 3.1 JSON at `/openapi.json` and an interactive reference at `/docs`.

Asset delivery, decoder-level media inspection, transformations, the dashboard, Docker Compose,
and AI features are **not implemented yet**. Accepted uploads remain in `processing` with a durable
`media.inspect` job until the worker arrives in the next phase task.

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

The simple-upload endpoint accepts exactly one raw media file per request. For example, after
signing in and retaining the session cookie:

```bash
curl --request POST \
  --cookie cookies.txt \
  --header 'Content-Type: image/jpeg' \
  --data-binary @photo.jpg \
  'http://localhost:3001/api/v1/organizations/ORGANIZATION_ID/projects/PROJECT_ID/uploads?filename=photo.jpg'
```

Service clients can send a project-scoped `assets:write` key in `x-api-key`. Supply
`Content-Digest: sha-256=:BASE64_DIGEST:` when end-to-end checksum verification is needed. Simple
uploads require `Content-Length`, default to private visibility, are limited to 100 MiB, and share a
configurable 10 GiB quota per project.

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
| `pnpm --filter @aeonic/api test:s3` | Run the opt-in live S3 compatibility contract |
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
