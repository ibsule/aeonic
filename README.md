# Aeonic

Aeonic is an open-source, self-hosted media platform for storing, processing, finding, and
delivering images, videos, PDFs, and office documents.

It gives individual developers and small teams one workspace for media operations, a versioned
REST API, transformation URLs, and optional media intelligence—without making AI a dependency of
the core product.

*Version 1.0.0-rc.2*

> **Release status:** `1.0.0-rc.2` is a hardened release candidate, not the final v1 release. Core
> local verification is complete; hosted release, independent review, ARM64 hardware, and extended
> operational acceptance gates remain open.

## What Aeonic does

- **Manage media:** upload, inspect, organize, search, and control access to media in isolated
  organizations and projects.
- **Process and deliver:** create deterministic image transformations, video derivatives, document
  previews, and expiring signed delivery URLs.
- **Operate with confidence:** use resumable uploads, storage quotas, audit history, health checks,
  backup guidance, and a dedicated media worker.
- **Add intelligence when useful:** enable semantic media search and approval-gated workflow agents
  without affecting uploads, transformations, or delivery when AI is disabled.

Aeonic supports images, videos, PDFs, and LibreOffice-readable office documents. ZIP archives are
not catalog assets in v1. See the [support matrix](docs/support-matrix.md) for the complete release
candidate scope.

## Run Aeonic locally with Docker

Docker Compose is the supported deployment path for v1. You need Docker Engine or Docker Desktop
with Compose v2, Git, and OpenSSL.

### 1. Configure the installation

```bash
cp .env.compose.example .env
```

Generate two independent secrets:

```bash
openssl rand -base64 48
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Open `.env` and replace:

- `BETTER_AUTH_SECRET` with the first value.
- The value after `primary:` in `DELIVERY_SIGNING_KEYS` with the second value.

Keep `AEONIC_ORIGIN=https://localhost` for local evaluation. Never commit `.env`.

### 2. Build and start

```bash
docker compose config --quiet
docker compose build
docker compose run --rm worker --enable-source-maps dist/doctor.js
docker compose up -d
docker compose ps
```

The doctor checks configuration, SQLite, storage permissions, Sharp, FFmpeg, Poppler, and
LibreOffice before startup.

### 3. Complete first-run setup

Open <https://localhost>. Caddy uses a local certificate authority for the default development
origin, so your browser may require you to explicitly trust its local certificate.

The first-run screen creates the installation owner, organization, and first project. Save the
owner password in a password manager: Aeonic does not retain a recoverable copy.

Useful local endpoints:

- Dashboard: <https://localhost>
- API reference: <https://localhost/docs>
- OpenAPI 3.1 document: <https://localhost/openapi.json>
- Readiness: <https://localhost/health/ready>

### Common local commands

```bash
docker compose ps
docker compose logs --tail=200 api worker edge
docker compose run --rm worker --enable-source-maps dist/doctor.js
docker compose down
```

`docker compose down` retains named volumes. Do **not** use `docker compose down -v` unless you
intend to permanently delete Aeonic's local application data.

For a domain, certificate trust, backup, and network-boundary guidance, continue with the
[Docker Compose deployment guide](docs/deployment.md). Review [upgrade and rollback](docs/upgrade.md)
before changing versions.

## Develop from source

Source development requires:

- Node.js 24 LTS
- pnpm 11.25.0 through Corepack
- FFmpeg and ffprobe
- Poppler utilities: `pdfinfo`, `pdftotext`, and `pdftoppm`
- LibreOffice for office-document previews

Install and verify the workspace:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Run the API and dashboard in one terminal, then the media worker in another. Both processes must
use the same database and storage configuration.

```bash
# Terminal 1: API and dashboard
pnpm dev

# Terminal 2: media worker
pnpm --filter @aeonic/api dev:worker
```

The development dashboard runs at <http://localhost:4173> and proxies API requests to
<http://localhost:3001>. Direct runtime processes read configuration from their environment; they
do not automatically load `.env` files.

Before submitting a change, run:

```bash
pnpm check
```

This verifies release metadata, formatting, lint, strict types, tests, and production builds. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the complete contribution workflow.

## Use the API

Aeonic exposes a versioned REST API and publishes its OpenAPI 3.1 contract at `/openapi.json`. The
interactive reference at `/docs` documents authentication, request bodies, responses, and error
schemas for the exact running version.

The API supports:

- Secure browser sessions and project-scoped API keys
- Simple streaming and tus 1.0 resumable uploads
- Original and derived media delivery
- Canonical image transformation URLs and named presets
- Asynchronous video and document derivatives
- Storage, quota, job, audit, and project administration
- Optional lexical/vector search and approval-gated media workflows

Use `x-api-key` for service clients and a cookie session for browser-oriented workflows. Error
responses follow RFC 9457 problem details. Consult the interactive reference for canonical endpoint
shapes rather than copying identifiers from examples.

Public compatibility guarantees are defined in [API stability and deprecation](docs/api-stability.md).

## Optional intelligence

AI features are disabled by default. Core upload, catalog, transformation, search, and delivery
remain available without an external provider or vector database.

- [Optional semantic search](docs/semantic-search.md) explains provider configuration, privacy,
  spend ceilings, index evaluation, activation, and rollback.
- [Approval-gated media workflows](docs/agent-workflows.md) explains immutable plans, human
  approval, exact-target execution, and the optional MCP server.

## Architecture at a glance

The supported Compose deployment contains three production services:

- **Edge:** Caddy terminates TLS, serves the dashboard, and proxies API traffic.
- **API:** Express provides authentication, project control, uploads, delivery, and job
  coordination.
- **Worker:** a separate process inspects media and produces bounded image, video, PDF, and office
  derivatives.

SQLite and local object data live on persistent storage shared by the API and worker. S3-compatible
object storage is optional. The API and worker are internal services; only the edge publishes host
ports.

## Documentation

| Goal | Guide |
| --- | --- |
| Deploy and operate Aeonic | [Docker Compose deployment](docs/deployment.md) |
| Upgrade, restore, or roll back | [Upgrade and rollback](docs/upgrade.md) |
| Understand supported environments and media | [Support matrix](docs/support-matrix.md) |
| Configure optional semantic retrieval | [Optional semantic search](docs/semantic-search.md) |
| Connect approval-gated agent tools | [Media workflow agents](docs/agent-workflows.md) |
| Understand compatibility guarantees | [API stability and deprecation](docs/api-stability.md) |
| Review security controls and manual gates | [Security verification](docs/security-verification.md) |
| Reproduce performance checks | [Performance verification](docs/performance.md) |
| Evaluate a release candidate | [Release checklist](docs/release-checklist.md) |
| Review user-visible release changes | [Changelog](CHANGELOG.md) |

## Repository layout

```text
apps/
  api/                 Express API, workers, MCP server, and persistence
  dashboard/           React and Vite operator workspace
packages/
  contracts/           Transport schemas and shared public types
docs/                  Public operator, API, security, and release guidance
scripts/               Verification, maintenance, and benchmark tools
```

Internal architecture research and planning are maintained separately from the public source
repository.

## Security

Do not report suspected vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) to use
the repository's private reporting flow.

## License

Aeonic is available under the [MIT License](LICENSE).
