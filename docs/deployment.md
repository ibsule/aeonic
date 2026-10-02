# Docker Compose deployment

Aeonic’s supported deployment is one Docker Compose project with a public Caddy edge, an internal
Express API, and an internal media worker. The API and worker share the SQLite database and local
object volume. Only Caddy publishes host ports.

## First start

1. Install Docker Engine with the Compose v2 plugin.
2. Copy `.env.compose.example` to `.env`.
3. Set `AEONIC_ORIGIN` to the final HTTPS origin. Caddy obtains a public certificate when this is a
   resolvable domain. The `https://localhost` default uses Caddy’s local CA and is for evaluation.
   The read-only edge intentionally does not install that CA into any trust store. If local browser
   trust is needed, copy `/data/caddy/pki/authorities/local/root.crt` from the edge container and
   explicitly trust it on the development host; remove that trust when evaluation ends.

   ```bash
   docker compose cp edge:/data/caddy/pki/authorities/local/root.crt ./aeonic-local-root.crt
   ```
4. Generate independent secrets:

   ```bash
   openssl rand -base64 48
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

   Put the first value in `BETTER_AUTH_SECRET`. Put the second after `primary:` in
   `DELIVERY_SIGNING_KEYS`. Never commit `.env`.
5. Validate and start the stack:

   ```bash
   docker compose config --quiet
   docker compose build
   docker compose run --rm worker --enable-source-maps dist/doctor.js
   docker compose up -d
   docker compose ps
   ```

6. Open `AEONIC_ORIGIN` in a browser. The first-run screen atomically creates the owner,
   organization, and first project. No command-line API calls are needed after installation.

The API reference remains available at `/docs`; readiness is exposed at `/health/ready`.

## Operations

Use `docker compose logs --tail=200 api worker edge` for a bounded diagnostic view. Run the doctor
after changing configuration or the host. It validates configuration, data-path permissions,
SQLite integrity, media tools, and the runtime without changing application state. The S3 check
validates configuration but deliberately does not write a probe object.

The worker uses a 512 MiB temporary filesystem and conservative media limits. Increase the tmpfs
size and explicit input/output limits together when trusted workloads require it; do not remove
the limits. Application containers drop Linux capabilities, use `no-new-privileges`, and have
read-only root filesystems.

## Backup and recovery

A single Compose host is not disaster recovery. Back up the named `aeonic-data` volume and test
restoration on another host. SQLite runs in WAL mode: copying only `aeonic.db` while the service is
active can produce an inconsistent backup. Either stop `api` and `worker` while copying the complete
data volume, or use SQLite’s online backup API/tool and capture object storage at the same logical
point in time.

Keep Caddy data if retaining its local certificate authority or ACME account matters, but it is not
application data. Store encrypted backups separately from the Compose host. For S3 deployments,
enable bucket versioning and provider-side replication; SQLite still needs a consistent backup.

## Network boundary

Expose only TCP 80/443 and UDP 443 where HTTP/3 is desired. The internal Docker network prevents
direct external access to API and worker containers. If another trusted proxy terminates TLS, keep
the public origin HTTPS, preserve original host/protocol headers, and restrict direct Caddy access.
