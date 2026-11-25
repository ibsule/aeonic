# Aeonic documentation

This index is the starting point for installing, using, operating, integrating, and contributing to
Aeonic. The OpenAPI document served by a running installation remains the source of truth for HTTP
request and response shapes.

## Start here

| If you want to… | Read |
| --- | --- |
| Evaluate Aeonic locally | [Getting started](getting-started.md) |
| Understand its services and data flow | [Architecture](architecture.md) |
| Configure an installation | [Configuration reference](configuration.md) |
| Deploy a persistent instance | [Docker Compose deployment](deployment.md) |
| Fix a failed start or unhealthy service | [Troubleshooting](troubleshooting.md) |

## Product and integration guides

- [Authentication and authorization](authentication.md) explains browser sessions, roles, project
  assignments, API keys, and credential operations.
- [Support matrix](support-matrix.md) defines supported hosts, browsers, storage, media, and explicit
  v1 exclusions.
- [API stability and deprecation](api-stability.md) defines compatibility guarantees for the
  versioned REST API.
- [Optional semantic search](semantic-search.md) covers the AI worker, provider boundary, Qdrant,
  privacy controls, evaluation, and fallback behavior.
- [Media workflow agents](agent-workflows.md) covers immutable plans, human approval, MCP tools, and
  execution safety.

## Operations and assurance

- [Upgrade and rollback](upgrade.md)
- [Security verification](security-verification.md)
- [Performance verification](performance.md)
- [Release checklist](release-checklist.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

## Contributor references

- [Contributing guide](../CONTRIBUTING.md)
- Live API reference: `/docs`
- OpenAPI 3.1 document: `/openapi.json`
- Readiness endpoint: `/health/ready`

Documentation describes the current release only. When behavior and documentation disagree, treat
that as a defect and report it through the normal issue or security channel as appropriate.
