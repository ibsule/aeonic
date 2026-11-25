# Changelog

Aeonic follows Semantic Versioning. Starting with v1, breaking public API changes require a major
release except when an urgent security or data-integrity restriction is necessary.

## 1.0.0 - 2026-11-25

First stable release of Aeonic.

### Added

- A self-hosted media workspace for images, videos, PDFs, and supported office documents.
- Tenant-isolated organizations and projects, browser sessions, project API keys, roles, audit
  history, storage quotas, and OpenAPI 3.1 documentation.
- Simple and tus resumable uploads, local and S3-compatible storage, immutable originals, signed
  delivery, byte ranges, deterministic image transformations, and durable media derivatives.
- A hardened Docker Compose topology with separate Caddy edge, Express API, and media-worker images
  for `linux/amd64` and `linux/arm64`.
- Optional semantic search and approval-gated media workflow agents that remain outside the core
  availability path.
- Operator documentation for installation, architecture, configuration, authentication,
  troubleshooting, backup, upgrade, security, compatibility, and performance verification.

### Compatibility

- Docker Compose is the supported production deployment for v1.
- SQLite is the authoritative control plane; active-active API replicas are unsupported.
- The versioned REST API follows the guarantees in `docs/api-stability.md`.
- ZIP archives are not catalog assets in v1.

### Security

- Updated Better Auth, Express, Sharp, the Model Context Protocol SDK, Zod, Vite, Vitest, and
  affected transitive middleware to patched releases.
- Verified the production dependency graph reports no known vulnerabilities before the v1 source
  checkpoint.

### Upgrade notes

- Installations running either v1 release candidate can upgrade through the normal forward migration
  path after creating and restoration-testing a complete database-and-object backup.
- Rollback requires the matching pre-upgrade database and object state; database downgrades are not
  supported.
- Read `docs/upgrade.md` before changing an existing installation.

## 1.0.0-rc.2 - 2026-10-02

Hardening release candidate produced after scanning the complete production image set.

### Changed

- Split the web API and media worker into separate least-functionality images.
- Moved the API to a non-root distroless Node.js runtime and the media worker to a minimized Alpine
  runtime containing only its required processors.
- Rebuilt the exact signed Caddy 2.11.4 release commit with current patched Go and transitive module
  versions while preserving the upstream runtime image and configuration.
- Pinned all production base images by multi-architecture digest and updated Node.js to 24.21.0.
- Made the release workflow build, scan, attest, and sign API, worker, and edge independently for
  `linux/amd64` and `linux/arm64`.

### Security

- Removed package-manager and build tooling from production runtimes.
- Upgraded the transitive esbuild dependency to 0.28.2.
- Verified zero known high or critical vulnerabilities in all three local production images with
  Trivy 0.74.0 before cutting this candidate.

## 1.0.0-rc.1 - 2026-10-02

First feature-complete v1 release candidate.

### Added

- Tenant-isolated projects, membership, API keys, audit history, SQLite persistence, and OpenAPI 3.1.
- Local and S3-compatible storage, simple and tus uploads, immutable originals, signed private
  delivery, byte ranges, image transformations, presets, and durable video/document derivatives.
- Responsive operator workspace for installation, projects, uploads, assets, jobs, storage, API
  keys, optional semantic search, and exact-target approval-gated agent workflows.
- Optional AI worker and Qdrant profile with privacy controls, budgets, quality evaluation, and
  lexical fallback.
- Reproducible 100,000-asset metadata, 1 MiB delivery, and 12 MP transformation benchmarks.
- Weekly dependency and CodeQL checks plus multi-architecture release images with SBOM, provenance,
  high-severity scanning, and keyless signing.
- Public API stability, platform support, security evidence, release, backup, upgrade, and rollback
  documentation.

### Security

- Core containers use read-only roots, dropped capabilities, `no-new-privileges`, internal service
  networking, bounded media subprocesses, strict tenant-scoped storage keys, and fail-closed
  production configuration.
- Agent mutation requires an immutable exact-target plan, administrator review, single-use approval,
  worker-side revalidation, durable execution, and audit history.

### Upgrade notes

- Take and restore-test a complete pre-upgrade data-volume backup before migrating.
- Database migrations are forward-only. Rollback restores the matching pre-upgrade database and
  objects together, then runs the previous image version.
- Read [the upgrade and rollback guide](docs/upgrade.md) before changing an existing installation.

### Release status

This is a prerelease. Final 1.0 remains gated on the complete release checklist, including an
independent security review, five independent installations, registry-side artifact verification,
and reference-host soak/recovery evidence.
