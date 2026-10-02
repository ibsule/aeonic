# Security verification

Aeonic targets the intent of OWASP ASVS 5.0 Level 2 for its supported deployment. This document is
an evidence map, not a certification or a substitute for an independent review. Requirement-level
assessment must use the canonical [OWASP ASVS 5.0 release](https://github.com/OWASP/ASVS/releases/tag/v5.0.0).

## Automated release gates

- `pnpm check` runs formatting, linting, type checks, unit and integration tests, and production
  builds. CI installs the same media tools exercised by the runtime.
- `pnpm security:audit` fails on high or critical production dependency advisories. Moderate and low
  findings still require triage; passing does not mean there are no vulnerabilities.
- CodeQL runs its extended JavaScript and TypeScript query suite on pull requests, `main`, and a
  weekly schedule.
- Every amd64 and arm64 platform manifest in each tagged image is scanned at high severity before
  signing. The release is blocked when a scan finds a high or critical image vulnerability without
  remediation or a documented exception.
- Release images carry BuildKit SBOM and maximum-provenance attestations and are signed by digest
  using GitHub's OIDC identity.

## ASVS 5.0 Level-2-intent evidence map

| Control area | Implemented evidence | Remaining release evidence |
| --- | --- | --- |
| Architecture and secure design | Tenant IDs are carried through schema foreign keys, repositories, storage keys, jobs, AI vectors, and agent plans. Mutations use explicit policy and human approval. | Independent threat-model review and focused security review. |
| Input validation and business logic | Contract schemas, bounded pagination/body sizes, strict transform grammar, media limits, idempotency, optimistic concurrency, quotas, and adversarial policy tests. | Review production-specific limits against the reference workload. |
| Web frontend and API | Helmet defaults, no framework banner, same-origin production default, explicit CORS allowlist, structured problem responses, and OpenAPI positive/negative tests. | Browser testing against the deployed TLS origin and proxy configuration. |
| File handling | Content-derived type checks, immutable tenant-scoped storage keys, path containment, bounded image/video/document processing, no shell command construction, and hostile-media corpus tests. | Independent parser fuzzing and review of enabled media-tool versions. |
| Authentication and sessions | Better Auth email/password sessions, exact trusted origin, HTTPS required in production configuration, one-time API-key display, and hashed project API keys. | Operational password policy, account recovery, session lifetime, and credential-rotation review. |
| Authorization | Organization/project role checks at route and service boundaries; API-key capability mapping; cross-project and cross-tenant negative tests; concealed private delivery. | Independent authorization matrix review. |
| Cryptography and communications | Runtime secrets are minimum-length validated, signed delivery URLs use rotating keyed signatures, secret query values are redacted, and the supported edge terminates HTTPS. | Deployed TLS scan, secret-manager integration assessment, and key-rotation rehearsal. |
| Configuration and deployment | Fail-closed production configuration, read-only containers, dropped capabilities, no-new-privileges, internal service network, doctor checks, pinned CI actions, and immutable release digests. | Host hardening, firewall, registry retention, and GitHub environment protection review. |
| Data protection and privacy | Private-by-default assets, tenant filters, optional AI, AI exclusion controls, file-mounted provider secrets, and no raw secret logging. | Retention/deletion policy and applicable privacy-law assessment by the operator. |
| Logging and error handling | Structured request/audit events, sanitized public errors, signed-query redaction, job failure sanitization, and approval/execution audit trails. | External log retention, alerting, clock synchronization, and incident-response exercise. |
| Availability | Atomic leases, heartbeats, expiry recovery, bounded retries/timeouts, graceful shutdown, readiness separated from liveness, storage quotas, and performance harnesses. | Reference-host soak, crash/recovery drill, and backup restoration drill. |
| OAuth, tokens, WebRTC, webhooks | Not part of the supported v1 surface. | Reassess before any such feature is enabled. |

## Required manual review before a v1 release

1. Resolve every high or critical dependency, CodeQL, and image finding, or record an owner-approved,
   time-bounded exception with impact, compensating controls, and expiry.
2. Have an independent reviewer focus on authentication, tenant isolation, signed delivery, uploads,
   media subprocess boundaries, agent approvals, and supply-chain workflows.
3. Exercise traversal, cross-project access, secret leakage, replay, stale approval, range parsing,
   cache isolation, worker crash, and expired-lease scenarios against the release candidate.
4. Run a deployed TLS and security-header assessment at the final HTTPS origin.
5. Store the tested commit, image digests, SBOM/provenance verification, signatures, raw scan outputs,
   and reviewer findings with the release evidence.

Security exceptions must never silently weaken a gate. Record who accepted the risk, why release is
still reasonable, the affected versions, a remediation owner, and an expiry date.
