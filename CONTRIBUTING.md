# Contributing to Aeonic

Aeonic is pre-1.0 and is being built in gated milestones. Please keep changes focused, tested, and
consistent with the currently shipped scope.

## Set up the workspace

Use Node.js 24 LTS and the package-manager version declared in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Run `pnpm dev` for local development. Copy `.env.example` only when you need to override defaults.

### S3-compatible storage contract

The normal test suite keeps live object-storage tests disabled. To verify an S3-compatible provider,
create an empty test bucket or allow the suite to create a temporary one, then run:

```bash
S3_TEST_ENDPOINT=http://127.0.0.1:9000 \
S3_TEST_ACCESS_KEY=test-access-key \
S3_TEST_SECRET_KEY=test-secret-key \
S3_TEST_CREATE_BUCKET=1 \
pnpm --filter @aeonic/api test:s3
```

`S3_TEST_BUCKET` and `S3_TEST_REGION` are optional. Never point the suite at a bucket containing
real data. Insecure HTTP endpoints require an explicit local test URL; production integrations
should use TLS.

## Quality requirements

Before opening a pull request:

1. Add or update tests for behavior changes.
2. Run `pnpm check` from the repository root.
3. Confirm documentation describes only behavior that exists.
4. Avoid unrelated dependency or formatting changes.
5. Explain security, compatibility, and migration effects when applicable.

## Commit conventions

Use an imperative, focused subject in the form `<type>: <description>`. Supported types include
`feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, and `chore`.

Examples:

```text
feat: add project creation endpoint
fix: reject asset paths outside storage root
docs: describe API key rotation
```

Keep each commit independently understandable and, whenever practical, passing the complete quality
gate.

## Releases

Aeonic follows Semantic Versioning. Before 1.0, minor releases may contain intentional contract
changes, but every breaking change requires release notes and a migration path. Patch releases are
reserved for compatible fixes and documentation changes.

A release must:

- Pass `pnpm check` from a clean checkout.
- Contain no undocumented critical or high-severity vulnerability.
- Include user-visible changes and migration instructions in release notes.
- Use a signed, annotated Git tag once release signing is configured.
- Publish only features verified in the release artifact.
