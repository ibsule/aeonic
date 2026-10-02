# Release checklist

Use one copy of this checklist for each release candidate. Store evidence outside the source tree or
in the release system; do not commit credentials, customer data, or private review material.

## Candidate identity

- [ ] Commit, annotated tag, application version, and API, worker, and edge image digests agree.
- [ ] Release notes describe user-visible changes, migrations, compatibility, and known issues.
- [ ] The tested source tree is clean and `pnpm release:verify` passes.

## Automated gates

- [ ] Clean install completes on supported `linux/amd64` Compose.
- [ ] Clean install completes on supported `linux/arm64` Compose.
- [ ] `pnpm check` passes from a clean checkout with the declared Node and pnpm versions.
- [ ] Unit, integration, dashboard accessibility, adversarial media, tenant-isolation, agent-policy,
      range/cache, lease/crash, and OpenAPI tests pass.
- [ ] Production dependency audit, CodeQL, and every amd64 and arm64 release-image scan contain no
      unaccepted high or critical finding.
- [ ] SBOM and maximum provenance attestations are attached to all three image manifests.
- [ ] All three image digests have valid keyless signatures whose certificate identity and issuer match
      the release workflow.

## Operational gates

- [ ] Upgrade from the latest supported prior release preserves data and passes the doctor.
- [ ] A complete pre-upgrade backup is restored on a separate disposable installation and the prior
      release passes readiness, sign-in, representative download/range, and upload checks.
- [ ] API and worker termination during active work recover without false readiness, duplicate
      publication, or a permanent lease within 60 seconds.
- [ ] The 100,000-asset metadata benchmark and 12 MP transform benchmark meet the documented targets
      on the reference host with raw JSON retained.
- [ ] A release-length soak has no unbounded memory growth, corrupt output, or stuck work.
- [ ] README, deployment, support, security, API stability, and upgrade claims match the artifact.

## Independent security review

- [ ] A reviewer who did not implement the release candidate tests authentication, authorization,
      tenant isolation, uploads, media subprocesses, signed delivery, agent approvals, and the image
      supply chain.
- [ ] Findings include severity, reproduction, affected versions, owner, disposition, and retest.
- [ ] Every high or critical finding is fixed, or an explicit time-bounded exception is accepted by
      the project owner and disclosed where users need it.

## Independent installation feedback

Final v1 requires at least five installations performed independently of the maintainer. Do not
count repeated installs by one person or an install performed through the maintainer's own shell.

| Install | Operator/reference | Architecture and host | Fresh or upgrade | Result | Evidence location |
| --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |
| 2 |  |  |  |  |  |
| 3 |  |  |  |  |  |
| 4 |  |  |  |  |  |
| 5 |  |  |  |  |  |

Each record includes consent to retain the evidence, Compose and Docker versions, architecture,
start-to-ready duration, setup/sign-in result, one upload and delivery result, doctor output, upgrade
result when applicable, confusing steps, defects, and whether the operator would repeat the install
without assistance. Remove personal or infrastructure secrets before sharing results.

## Final decision

- [ ] All mandatory evidence is linked and independently reproducible.
- [ ] Deferred non-blocking findings have owners and target releases.
- [ ] The project owner records `release`, `hold`, or `reject` with date and rationale.

Do not rename an incomplete candidate as final merely to satisfy the checklist. Publish it as a
prerelease, fix the evidence gap, and repeat affected gates.
