# Deploying on Cookie

How LORB runs on Cookie, Pearson's citizen-developer platform, as a classic three-tier deployment:
a browser tier, one logic process, and the PostgreSQL database the platform provisions. This is a
re-hosting of the platform described in [deployment.md](deployment.md), not a redesign: the same
images' code, the same contracts, the same controls. What differs is who signs the user in, and
where the two surfaces that cannot share the API's origin live.

## The shape

```
 browser ──▶ shelf.cookie…   sign-in gateway ──▶ /portal/ /admin/ /console/  (static bundles, SSO)
                                    │            /auth/session               (hands the gateway's token back)
                                    └── pass-through ──▶ /api/v1/*           (Runtime, Evidence, Publisher, Admin, relay)
                                                              │
                                                              ▼
                                                    CNPG PostgreSQL (DATABASE_URL, provisioned)
 iframe  ──▶ shelf-player.cookie…/api/            Player Shell + bundled modules (static, no SSO)
 forwarder ─▶ shelf-lrs.cookie…/api/xapi/         learning record store, its own CNPG database
```

| Cookie app | Tier | What it runs | Image |
| --- | --- | --- | --- |
| `shelf` | logic + browser | Runtime API with the Evidence API, forwarder and relay, serving the learner portal, administration workspace and operations console from the same process (`SERVE_WEB_APPS=true`) | `deploy/cookie/shelf/Dockerfile` |
| `shelf-player` | browser (public) | Player Shell and the bundled content packages, served by a small Node static server under `/api/` | `deploy/cookie/shelf-player/Dockerfile` |
| `shelf-lrs` | logic | `packages/lrs`, the learning record store, with its own database | `deploy/cookie/shelf-lrs/Dockerfile` |

Each app is one container on port 8080 with `GET /health`, built from the platform's approved Node
base image, running as a non-root user. `deploy/cookie/export.sh <app> <dir>` assembles the tree the
app's repository receives: the whole workspace, minus what is not source, with that app's
Dockerfile and root files on top. The repository's own `.cookie.yaml` and CI workflow are the
platform's and are never part of an export.

## Why three apps and not one

Cookie authenticates every path of a citizen app at a sidecar gateway, except `/health`, `/readyz`
and anything under `/api/`. Two things in LORB cannot live behind that gateway:

- **The Player Shell.** A module runs in an iframe sandboxed without `allow-same-origin`. It has
  no cookies, so it can never complete a sign-in, and it fetches its own module-script bundle from
  an opaque origin, which only `Access-Control-Allow-Origin: *` permits. That wildcard must never be
  on the API's origin (see [deployment.md](deployment.md), "The Player Shell is not on that list").
  So the shell is its own app, and everything it serves sits under `/api/`, the one prefix the
  gateway leaves alone. `PLAYER_SHELL_BASE_PATH=/api` on the Runtime API builds launch and package
  URLs under that prefix while origin comparisons keep using the bare origin.
- **The learning record store.** The forwarder delivers with a bearer token, not a browser session,
  and the runbook is explicit that evidence needs a database of its own. `LRS_PATH_PREFIX=/api/xapi`
  serves the statements resource where the gateway passes it through; `/health` stays at the root.

Everything else is one app. The Runtime API already knew how to serve the three browser bundles
itself; on Cookie that is the only way they are served.

## Identity

The gateway signs users in against Keycloak (federated to Entra ID) and forwards
`Authorization: Bearer <JWT>` on the paths it protects. LORB keeps verifying tokens itself on the
API routes, exactly as before, because those routes are pass-through and receive whatever the caller
sends. Two things bridge the gap:

1. **The browser applications collect the gateway's token** from `GET /auth/session` on their own
   origin, a route the gateway protects because it is not under `/api/`. The route verifies the
   forwarded token against the configured issuer and audience and returns it; from then on the
   application presents it on API calls as it would a token from any provider. The applications no
   longer run an authorization-code flow of their own; sign-out is a plain navigation to the
   gateway's `/oauth2/sign_out`. `PLATFORM_SESSION_ENDPOINT=true` turns the route on and tells the
   bundles where it is (`VITE_PLATFORM_SESSION_URL`).
2. **The Runtime API verifies Keycloak tokens.** The platform injects `OIDC_ISSUER` (the realm) and
   `OIDC_CLIENT_ID` (the audience, by default). A realm's key set is found under the realm rather
   than at the well-known path, which the configuration now derives. Roles come from the `groups`
   claim: `OIDC_ROLE_CLAIM=groups` and `ADMIN_ALLOWED_ROLES` naming the group that may administer.
   `OIDC_PLATFORM_ADMIN_CLAIM=groups=<group>` makes membership of a group the platform-administrator
   marker.

Pseudonyms are unchanged: `HMAC(tenant secret, issuer | subject | purpose)`, with Keycloak's stable
`sub` as the subject. The tenant secret remains the identity function for the whole evidence record.

## Route table

Which side of the gateway each route lands on, and why that is the right side.

| Route | Gateway | Who calls it, with what |
| --- | --- | --- |
| `/portal/`, `/admin/`, `/console/` and their assets | protected | A signed-in browser. |
| `/auth/session` | protected | The application, same-origin, to collect the forwarded token. |
| `/api/v1/runtime/launches`, catalogue, attempts, admin, publisher | pass-through | The application with the token above; the Runtime API verifies it. |
| `/api/v1/runtime/jwks`, `/api/v1/lti/*` | pass-through | The Player Shell and LTI tools, anonymously; public by design. |
| `/api/v1/evidence/*`, `/api/v1/relay/*`, attempt state and complete | pass-through | The shell and modules from an opaque origin, holding a descriptor. |
| `/api/v1/internal/*` | pass-through | Services holding `RUNTIME_INTERNAL_SERVICE_TOKEN`. |
| `/health`, `/ready` | pass-through / protected | The platform's probes use `/health`; `/ready` is for an operator. |
| `/metrics` | protected | An operator with a session. |

## Configuration

Set through the platform's environment variable management; secrets marked as such. Values the
platform injects are listed as *platform* and must not be set by hand.

### shelf

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *platform* | Provisioned database. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | *platform* | Issuer and audience for token verification. |
| `OIDC_ALGORITHMS` | `RS256` | Keycloak signs with RS256. |
| `OIDC_ROLE_CLAIM` | `groups` | |
| `ADMIN_ALLOWED_ROLES` | the group that may administer | Initially the app's own access group, so everyone granted access is an administrator; narrow it to a dedicated group before real use. |
| `OIDC_PLATFORM_ADMIN_CLAIM` | `groups=<group>` | Same caveat. |
| `RUNTIME_PUBLIC_ISSUER` | `https://<app host>` | |
| `PLAYER_SHELL_ORIGIN` | `https://<player host>` | |
| `PLAYER_SHELL_BASE_PATH` | `/api` | |
| `ALLOWED_CONSUMER_ORIGINS` | `https://<app host>` | The portal is same-origin; the list must still name one origin. |
| `PSEUDONYM_TENANT_SECRET` | secret, 32 bytes hex | See [key-rotation.md](key-rotation.md). |
| `DESCRIPTOR_PRIVATE_KEY_PEM`, `DESCRIPTOR_KID` | secret | `pnpm keys:generate`. |
| `RUNTIME_INTERNAL_SERVICE_TOKEN` | secret, 32+ characters | |
| `LRS_ENDPOINT` | `https://<lrs host>/api/xapi` | The service appends `/statements`. |
| `LRS_BEARER_TOKEN` | secret | One of the tokens the store accepts. |
| `SERVE_WEB_APPS`, `PLATFORM_SESSION_ENDPOINT`, `PORT`, `NODE_ENV` | set in the image | |

### shelf-lrs

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | *platform* — read as `LRS_DATABASE_URL`'s fallback |
| `LRS_ACCEPTED_BEARER_TOKENS` | secret; the token the Runtime API sends |
| `LRS_PATH_PREFIX`, `PORT`, `NODE_ENV` | set in the image |

### shelf-player

Nothing beyond what the image sets: `PORT` and `PLAYER_BASE_PATH=/api`.

## Standing it up

1. Deploy `shelf-lrs` first with its database provisioned and a bearer token set. Confirm
   `GET /api/xapi/about` answers `{"version":["1.0.3"]}`.
2. Deploy `shelf-player`. Confirm `GET /api/` returns the shell with
   `access-control-allow-origin: *`.
3. Provision `shelf`'s database, set the variables above, deploy. Migrations run at start-up.
   Confirm `GET /ready` reports `persistence: "postgres"` and that
   `GET /api/v1/runtime/jwks` publishes the configured `kid`, never `ephemeral-dev-key`.
4. Open `/admin/`, sign in through the platform, create a repository and register content. A new
   catalogue is empty: example content is refused in production.

## Deliberately not carried over

- **The document converter.** It shells out to LibreOffice and needs a persistent volume and a
  single replica, which does not fit a citizen app. Word and PowerPoint upload is unavailable until
  it is hosted elsewhere and `DOCUMENT_CONVERTER_URL` points at it.
- **The agent connector.** `SERVE_MCP_CONNECTOR` folds it into the same process, but its `/mcp`
  route would need to be pass-through and the platform's own bearer-token resource mode; left off
  until that is arranged.
- **The development identity provider and development record store.** Development conveniences,
  refused in production by configuration.
