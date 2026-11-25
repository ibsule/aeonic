# Getting started

This guide takes a new installation from an empty checkout to its first uploaded asset. Docker
Compose is the supported v1 deployment path.

## Requirements

- Docker Engine or Docker Desktop with Compose v2
- Git
- OpenSSL
- A current Chrome, Edge, Firefox, or Safari release

For production sizing and platform limits, read the [support matrix](support-matrix.md).

## 1. Prepare configuration

```bash
git clone https://github.com/ibsule/aeonic.git
cd aeonic
cp .env.compose.example .env
```

Generate two independent secrets:

```bash
openssl rand -base64 48
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Put the first value in `BETTER_AUTH_SECRET`. Put the second after `primary:` in
`DELIVERY_SIGNING_KEYS`. Keep `AEONIC_ORIGIN=https://localhost` for local evaluation, or use the
final HTTPS origin for a persistent installation. Do not commit `.env`.

## 2. Validate and start

```bash
docker compose config --quiet
docker compose build
docker compose run --rm worker --enable-source-maps dist/doctor.js
docker compose up -d
docker compose ps
```

Wait until `api` reports healthy. If it does not, run:

```bash
docker compose logs --tail=200 api worker edge
```

Continue with [troubleshooting](troubleshooting.md) when the doctor or a health check fails.

## 3. Complete first-run setup

Open <https://localhost>. The local origin uses Caddy's private certificate authority, so a browser
warning is expected until that development CA is explicitly trusted. Production domain names use
normal public certificate issuance.

The setup screen creates the installation owner, organization, and first project in one database
transaction. Store the owner password in a password manager; Aeonic does not provide a recovery
email flow in v1.

## 4. Upload and inspect media

1. Open the project workspace.
2. Upload an image, video, PDF, or supported office document.
3. Watch the job reach a terminal state.
4. Open the asset to inspect metadata and available derivatives.
5. For images, request a basic transformation or create a named preset.

ZIP archives are not catalog assets. Consult the [support matrix](support-matrix.md) for format and
processor boundaries.

## 5. Create an API key when needed

Create a project key from the dashboard and select only the required scopes. Copy the secret when
it is shown; only its hash is retained. Service clients send it as `x-api-key`.

The running installation exposes interactive API documentation at `/docs` and its OpenAPI contract
at `/openapi.json`. Read [authentication and authorization](authentication.md) before integrating a
service client.

## Stop or remove the evaluation stack

Stop containers without deleting data:

```bash
docker compose down
```

Named volumes contain the database, objects, Caddy state, and optional vectors. Do not delete those
volumes unless you intentionally want to destroy the installation and have a tested backup.

Next: [deployment](deployment.md), [configuration](configuration.md), and
[upgrade and rollback](upgrade.md).
