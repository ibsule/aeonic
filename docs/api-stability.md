# API stability and deprecation

The OpenAPI 3.1 document at `/openapi.json` is the source of truth for Aeonic's supported HTTP
contract. Routes absent from that document are internal and may change without compatibility
notice. The dashboard and MCP adapter are clients of the same documented service boundaries.

## Versioning policy

- Aeonic follows Semantic Versioning for the application, container images, and OpenAPI `info.version`.
- Before 1.0, a minor release may intentionally change a public contract, but release notes and an
  upgrade path are required.
- Starting at 1.0, compatible additions and optional fields may ship in a minor release. Breaking
  changes require a major release unless they close an actively exploitable vulnerability.
- Patch releases contain compatible fixes. Clients must ignore unknown response fields.
- Immutable media URLs include the asset version and transformation grammar. Existing canonical
  URLs are not repointed to different source bytes.

## Deprecation process

A supported operation, field, media type, or behavior is deprecated before removal. The OpenAPI
description and release notes identify the replacement and the earliest removal release. Once 1.0
is final, normal deprecations remain available for at least 90 days and one minor release, whichever
is longer. When practical, HTTP responses include `Deprecation` and `Sunset` headers plus a `Link`
to migration guidance.

Immediate restriction is allowed only for a security or data-integrity issue. The release notes
must explain the risk, affected versions, and migration or mitigation.

## Compatibility responsibilities

- Clients should generate or validate against the OpenAPI document for the exact server release.
- Clients must send declared content types, honor status codes, validators, pagination cursors, and
  idempotency semantics, and must not parse human-readable error text.
- Server upgrades preserve documented stored data through reviewed forward migrations. Database
  downgrades are unsupported; rollback restores the matching pre-upgrade backup.
- Provider-specific behavior outside Aeonic's documented S3 and AI boundaries is not part of the
  public contract.
