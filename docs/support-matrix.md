# Support matrix

This matrix defines the v1 release-candidate test surface. “Supported” means defects are accepted
when the installation follows the documented configuration; it does not replace provider or
operating-system support policies.

| Area | Supported v1 target | Notes |
| --- | --- | --- |
| Deployment | Docker Engine with Compose v2 on current security-supported Linux | Compose is the only supported production deployment for v1. |
| CPU architecture | `linux/amd64`, `linux/arm64` | Tagged API, worker, and edge images are each built as a multi-architecture manifest. |
| Host capacity | 4 vCPU, 8 GiB RAM, SSD, correctly sized persistent storage | The reference performance profile; smaller hosts may work without the published targets. |
| Browser | Latest two stable major versions of Chrome, Edge, Firefox, and Safari | JavaScript, cookies, secure contexts, and modern CSS are required. |
| API runtime for contributors | Node.js 24 and the pnpm version declared in `package.json` | Production users run the published containers. |
| Database | Bundled SQLite on the named data volume | Network filesystems and multiple API writers are unsupported. |
| Local storage | Aeonic-owned filesystem on the same Compose host | Must be persistent, writable by the container user, and included with database backups. |
| Object storage | S3-compatible service passing Aeonic's opt-in contract suite over TLS | Provider lifecycle, replication, credentials, and availability remain operator responsibilities. |
| Edge/TLS | Bundled Caddy edge with an HTTPS origin | Direct public exposure of the API or worker is unsupported. |
| AI | Disabled by default; configured OpenAI-compatible provider plus Qdrant profile | AI failure must not affect core upload, catalog, transformation, or delivery readiness. |

## Media inputs

Aeonic accepts images, videos, PDFs, and supported LibreOffice-readable office documents only when
content inspection agrees with the declared type and configured safety limits. Codec and office
format support is bounded by the exact FFmpeg, Poppler, LibreOffice, sharp, and libvips versions in
the release image. A file being parseable does not imply every embedded feature is preserved.

ZIP archives are not catalog assets in v1. Office container formats may internally use ZIP, but are
accepted only through the document allowlist and inspection path.

## Explicitly outside v1 support

- Kubernetes, Docker Swarm, Windows containers, and direct bare-metal production installs.
- Active-active API replicas sharing SQLite or the local object directory.
- Database downgrades, copying a live SQLite file without its consistency requirements, or restoring
  a database independently of its matching objects.
- Modified release images, unreviewed schema changes, or direct writes to Aeonic-managed storage.
- Provider guarantees, legal compliance, disaster recovery, and availability beyond the single-host
  design.
