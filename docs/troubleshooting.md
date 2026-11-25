# Troubleshooting

Start with bounded evidence and avoid editing SQLite, object files, or named volumes directly.

```bash
docker compose ps
docker compose logs --tail=200 api worker edge
docker compose run --rm worker --enable-source-maps dist/doctor.js
```

When the optional profile is enabled, add `ai-worker qdrant` to the logs command.

## Configuration rejected before startup

Run `docker compose config --quiet`, then inspect the doctor's exact failure. Common causes are:

- `BETTER_AUTH_SECRET` is missing or shorter than 32 characters.
- `DELIVERY_SIGNING_KEYS` is not `id:base64url-secret` or decodes to fewer than 32 bytes.
- `AEONIC_ORIGIN`, authentication, and delivery origins disagree.
- Only one S3 credential is set, the bucket is missing, or a production endpoint uses insecure HTTP.
- AI is enabled without explicit models, file-mounted credentials, pricing, or Qdrant protection.

After changing `.env`, recreate affected containers:

```bash
docker compose up -d --force-recreate
```

## Browser reports `Invalid origin`

Use one exact origin consistently, including scheme and port. For the default Compose deployment,
keep `AEONIC_ORIGIN=https://localhost` and browse to that exact URL. Do not add a path or trailing
slash. Recreate the API and edge after changing the origin.

If another proxy is in front of Caddy, enable `TRUST_PROXY` only when that proxy is trusted and
direct access is blocked.

## Local TLS warning

The localhost deployment uses Caddy's local certificate authority. Either accept the warning for a
disposable evaluation or explicitly export and trust the local root as described in
[deployment](deployment.md). Never distribute that development root as a production certificate.

## API is unhealthy

Check the API logs and doctor output. Verify that the named data volume is writable by container
user `1000:1000`, SQLite passes integrity checks, required secrets are present, and the host clock is
correct. Do not copy only `aeonic.db` from a live WAL-mode installation.

The worker waits for API readiness. A worker dependency failure is usually a consequence of an API
startup failure, not a separate worker problem.

## Upload remains incomplete or fails

- Confirm project quota and simple/tus upload limits.
- Confirm `TUS_STORAGE_PATH` is persistent and has free space.
- Do not place TUS staging inside immutable object storage.
- Compare the declared media type with the inspected content.
- Review configured image, video, and document safety limits.
- For S3, verify bucket policy, endpoint TLS, path-style mode, and clock synchronization.

Expired or abandoned resumable uploads are reconciled according to the configured expiration and
stale thresholds.

## Job is queued or running too long

Inspect worker logs and confirm the media tools pass the doctor. A terminated worker's lease should
expire and become recoverable. Do not shorten lease or timeout values without maintaining the
heartbeat relationship and allowing the processor enough time to stop safely.

For repeated deterministic failures, inspect the job's public error code and worker logs. Avoid
publishing raw customer media or provider output in an issue.

## Sign-in password was lost

Aeonic v1 has no email recovery flow and does not retain a recoverable password. Restore access
through a previously tested operational recovery procedure or restore a known-good backup. Direct
database password replacement is unsupported because it can bypass application invariants and
leave sessions or audit expectations inconsistent.

## API key stopped working

Confirm the key is enabled, unexpired, assigned to the same organization and project in the URL,
and contains the endpoint's required scope. The full key is shown only once. Create a replacement
when the secret is unavailable; hashes cannot be reversed.

If `x-api-key` is present but invalid, Aeonic does not fall back to a cookie session. Remove the
header when testing browser authentication.

## Semantic search degraded to lexical results

This is expected when AI is disabled or the provider/Qdrant circuit is unavailable. Core readiness
should remain healthy. Inspect `ai-worker` and Qdrant, provider timeouts, circuit-breaker state,
budget configuration, index evaluation, and active-index provenance. Never activate a failed
candidate index manually.

## Collecting a support bundle

Record the Aeonic version, host architecture, Docker and Compose versions, `docker compose ps`,
doctor output, bounded sanitized logs, reproduction steps, and whether the issue survives a clean
restart. Remove cookies, API keys, signed URLs, provider credentials, customer identifiers, and
private media before sharing evidence.

Security-sensitive findings belong in the private process described by [SECURITY.md](../SECURITY.md).
