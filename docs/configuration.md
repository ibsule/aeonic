# Configuration reference

Aeonic reads configuration from environment variables. Docker Compose loads `.env` and supplies
safe container paths and production defaults; contributors can start from `.env.example`. The
application validates values and fails closed before serving traffic when required production
configuration is missing.

## Required production values

| Variable | Purpose |
| --- | --- |
| `AEONIC_ORIGIN` | Final public HTTPS origin used by the Compose edge |
| `BETTER_AUTH_SECRET` | Session and authentication secret with at least 32 characters |
| `DELIVERY_SIGNING_KEYS` | Comma-separated `id:base64url-secret` entries; each secret is at least 32 bytes |

Generate independent authentication and delivery secrets. Never reuse a provider credential,
database value, or signing key.

## Runtime and HTTP

| Variable | Default | Notes |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `CORS_ORIGINS` | none in production | Exact comma-separated HTTP origins without paths |
| `TRUST_PROXY` | `false` | Enable only behind a trusted proxy that controls forwarded headers |
| `REQUEST_TIMEOUT_MS` | `30000` | Accepted range: 1–300 seconds |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown allowance |
| `MAX_JSON_BODY_BYTES` | `1048576` | JSON limit; media uploads use separate limits |

Compose sets the internal API host, port, database path, object path, and authentication URL. Do not
publish the API or worker container ports directly.

## Storage and uploads

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `PROJECT_STORAGE_QUOTA_BYTES` | `10737418240` | Default 10 GiB project quota |
| `UPLOAD_MAX_BYTES` | `104857600` | Simple-upload limit |
| `TUS_UPLOAD_MAX_BYTES` | `5368709120` | Resumable-upload limit |
| `TUS_UPLOAD_EXPIRATION_MS` | `86400000` | Incomplete upload lifetime |
| `UPLOAD_STALE_AFTER_MS` | `3600000` | Reconciliation threshold |

For S3, configure `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, path-style behavior, credentials,
and an optional prefix. Production endpoints must use TLS. Prefer a dedicated bucket and narrowly
scoped credential. S3 does not replace the SQLite backup.

## Worker and media limits

`WORKER_POLL_MS`, `WORKER_LEASE_MS`, `WORKER_HEARTBEAT_MS`, and `WORKER_JOB_TIMEOUT_MS` control job
execution. The heartbeat must remain less than half the lease duration.

Image, video, and document safeguards are controlled by the `IMAGE_*`, `VIDEO_*`, and `DOCUMENT_*`
variables in `.env.example`. Increase limits only after sizing CPU, memory, temporary storage, and
timeouts together. Removing limits is unsupported.

## Delivery

| Variable | Default | Notes |
| --- | --- | --- |
| `DELIVERY_URL_TTL_SECONDS` | `900` | Private signed-URL lifetime |
| `PUBLIC_DELIVERY_CACHE_SECONDS` | `31536000` | Cache lifetime for immutable public delivery |
| `DELIVERY_BASE_URL` | authentication origin | Public URL used when generating delivery links |

`DELIVERY_SIGNING_KEYS` supports multiple entries for rotation. The first entry signs new URLs;
remaining entries verify existing URLs during a controlled overlap window.

## Optional intelligence

Core media behavior requires none of these values. To enable intelligence, configure explicit model
snapshots, provider credentials, pricing, embedding dimensions, and Qdrant, then start the `ai`
profile. Production provider and Qdrant credentials must be supplied through mounted files.

Read [optional semantic search](semantic-search.md) before changing `AI_PIPELINE_VERSION` or
embedding dimensions because either change requires a new evaluated index.

## Validate changes

```bash
docker compose config --quiet
docker compose run --rm worker --enable-source-maps dist/doctor.js
docker compose up -d
docker compose ps
```

Run the doctor after every configuration, host, storage, or processor change. It is read-only and
reports configuration and dependency failures before normal startup.
