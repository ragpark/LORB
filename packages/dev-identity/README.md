# Development identity provider

A minimal OIDC-shaped token issuer for local development and continuous integration.

`POST /dev-login` with a subject returns a ten-minute ES256 access token with audience
`lorb-runtime`; `GET /.well-known/jwks.json` publishes the key it signed with. That is the whole
service.

## What it is not

There is no password, no consent screen, no user directory and no session. It mints a token for
whatever subject it is asked for. It exists so `pnpm dev` and the test suites need no external
provider, and for nothing else.

The Runtime API accepts it only when `ALLOW_SYNTHETIC_IDENTITY` is set, and production configuration
refuses that flag outright — so a deployed environment cannot fall back to this by misconfiguration.
Point `OIDC_ISSUER` at your real provider instead; see
[docs/runbooks/deployment.md](../../docs/runbooks/deployment.md).

## Roles

Pass `role: "admin"` to obtain a token the administration surfaces accept, and
`platform_admin: true` to bypass repository membership checks. Both mirror the claims a real provider
would be configured to emit, so the code under test is the same code that runs in production.
