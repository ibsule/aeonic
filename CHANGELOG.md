# Changelog

Aeonic follows Semantic Versioning. Before the final 1.0 release, release candidates may still
change in response to security review, independent installation feedback, or release-gate findings.

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
