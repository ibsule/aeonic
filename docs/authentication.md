# Authentication and authorization

Aeonic separates identity, tenant membership, project assignment, and action authorization. A valid
login does not by itself grant access to an organization or project.

## Browser sessions

Better Auth provides email/password accounts and SQLite-backed sessions under `/api/auth`. The
dashboard uses these operations:

| Operation | Endpoint |
| --- | --- |
| Sign in | `POST /api/auth/sign-in/email` |
| Inspect session | `GET /api/auth/get-session` |
| Sign out | `POST /api/auth/sign-out` |

Production uses secure cookies. `BETTER_AUTH_URL`, `AEONIC_ORIGIN`, proxy handling, and trusted
origins must describe the same public HTTPS installation. `BETTER_AUTH_SECRET` is required in
production and must be unique per installation.

Aeonic v1 does not provide password-reset email, MFA, passkeys, SAML, OIDC, or LDAP. Store the owner
credential in a password manager and maintain a tested backup. Changing a database password hash
manually is unsupported.

## Registration and invitations

The first-run setup endpoint atomically creates the installation owner, organization, and first
project, then closes itself. Better Auth's email registration endpoint remains available so an
invited person can establish an account, but an unassigned account cannot create organizations or
access projects.

Owners and administrators invite people through the organization flow. Invitation and membership
changes are written to the audit log. Email verification is not required in v1, so operators must
verify invitation addresses and role selection through their own trusted communication channel.

## Roles and projects

| Role | Organization-wide projects | Project capabilities |
| --- | --- | --- |
| Owner | Yes | Create, read, update, delete, keys, audit, upload, transforms, agent approval |
| Admin | Yes | Same v1 project actions as owner |
| Developer | No; explicit assignment required | Read, upload, transformations, API-key management |
| Viewer | No; explicit assignment required | Read only |

Project assignment does not replace organization membership; both must be valid. Removing either
one removes access. Authorization failures return a generic denial and do not disclose another
tenant's resources.

## Project API keys

API keys are intended for service clients. Create them from an authenticated user session, choose
the minimum required scopes, and send the resulting secret once as:

```http
x-api-key: aek_...
```

Supported scopes are `projects:read`, `assets:read`, `assets:write`, `assets:delete`, and
`jobs:read`. A key is bound to one organization and project. Aeonic checks the key hash, enabled and
expiry state, path organization, path project, and required resource action on every request.

The full secret is displayed only at creation; later listings expose metadata and a prefix. Revoke
a key immediately when it is lost, copied into logs, committed, or no longer needed. API keys cannot
be exchanged for browser sessions.

If a request contains `x-api-key`, Aeonic treats it as an API-key request. An invalid key does not
fall back to an accompanying browser cookie.

## Credential operations

- Keep `.env` and mounted secret files outside version control.
- Rotate API keys by creating and deploying a replacement before revoking the old key.
- Rotate delivery-signing keys separately from authentication credentials; retain the previous
  delivery key only for the intended URL overlap window.
- Rotating `BETTER_AUTH_SECRET` invalidates the trust basis for existing sessions and must be treated
  as a planned maintenance operation.
- Review `api_key.created`, `api_key.revoked`, membership, invitation, and session-adjacent audit
  events during incident response.

The interactive reference at `/docs` identifies whether each endpoint accepts cookie authentication,
an API key, or both.
