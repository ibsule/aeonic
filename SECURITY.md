# Security policy

## Supported versions

Aeonic is pre-1.0. Security fixes are applied to the latest release on `main`; older development
snapshots are not supported.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use the repository's
[private vulnerability reporting](https://github.com/ibsule/aeonic/security/advisories/new) flow.

Include, when possible:

- The affected version or commit.
- Reproduction steps or a minimal proof of concept.
- Expected and observed behavior.
- Potential impact and affected deployment conditions.
- Any suggested mitigation.

You should receive an acknowledgement within seven days. Triage, remediation, and disclosure timing
depend on severity and complexity. No fixed bounty is currently offered.

## Security scope

Particular areas of interest include tenant isolation, authorization bypass, path traversal, unsafe
media parsing, request smuggling, denial of service, secret exposure, and supply-chain compromise.

Reports that require social engineering, physical access, or attacks against unsupported modified
deployments may be out of scope, but responsible reports are still welcome.
