# Aeonic

Aeonic is an open-source, self-hosted media platform in active development. The intended product
will provide storage, transformation, delivery, and optional media intelligence for individual
developers and small teams.

## Current status

Version 0.2 provides the trustworthy API foundation. It currently ships:

- A Node.js 24 and strict TypeScript 6 workspace.
- A contract-validated Express 5 API.
- Validated environment configuration.
- Structured JSON logging with credential redaction.
- Separate liveness and readiness endpoints.
- RFC 9457-compatible error responses.
- Automated lint, format, type, test, and build checks.

Uploads, asset delivery, authentication, transformations, the dashboard, Docker Compose, and AI
features are **not implemented yet**. Earlier experimental routes were removed because they did not
meet the project's security or reliability requirements.

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
```

Use [`.env.example`](./.env.example) as the configuration reference. Environment variables can be
provided by your shell or process supervisor; automatic `.env` file loading is not currently part
of the runtime.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Build workspace dependencies and run development watchers |
| `pnpm build` | Produce clean ESM output for every package |
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
