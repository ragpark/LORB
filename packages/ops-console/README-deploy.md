# Deploying the Operations Console

Deployment procedure, including provider registration and the full variable matrix, is in
[docs/runbooks/deployment.md](../../docs/runbooks/deployment.md). This page lists only what is
specific to this surface.

## Build arguments

Vite substitutes these at build time. None is a credential: an OIDC client id identifies a public
client, which is what a browser application has to be. There is no way to supply them at runtime — a
rebuild is how you change an endpoint.

| Argument | Notes |
| --- | --- |
| `VITE_ENVIRONMENT_LABEL` | `PRODUCTION`, `STAGING` or `DEVELOPMENT`. Any other value fails the build |
| `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID` | Required unless the label is `DEVELOPMENT` |
| `VITE_OIDC_REDIRECT_URI` | This surface's own origin, registered with the provider |
| `VITE_OIDC_AUDIENCE` | The Runtime API's audience, so the token opens the right resource |
| `VITE_RUNTIME_API_BASE` | The Runtime API prefix, e.g. `https://runtime.lorb.example/api/v1/runtime` |
| `VITE_EVIDENCE_API_BASE` | The Evidence API prefix |
| `VITE_ALLOWED_API_ORIGINS` | Exact origins, comma-separated. No paths, no trailing slashes, no wildcards |
| `VITE_ADMIN_UI_ORIGIN` | Optional link to the Administration workspace |

## After deploying

1. `curl -sf https://<host>/health` returns `{"status":"ok"}` (served by nginx, not the application).
2. Sign in. You should be redirected to the identity provider and back.
3. In a non-production environment, confirm the environment notice is visible above everything a
   keyboard user can reach. In production, confirm there is none.
4. Confirm the surface loads live data rather than an error — a failure here is almost always an
   origin missing from the Runtime API's `ALLOWED_CONSUMER_ORIGINS`.

## Do not

- Build for a deployed environment without an identity provider. The image refuses, because the
  alternative is a surface whose only way in accepts any subject a caller names.
- Put a wildcard in an origin allow-list. The build refuses that too.
- Remove the environment notice, the origin allow-list, or any control the enforcement suite covers.

The console reaches concrete resources such as `repositories`; there is no `/api/v1/runtime/` root
route to health-check against.
