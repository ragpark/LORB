# Deployment

## What gets deployed

Six independently deployable units, each with its own image:

| Unit | Image | Public? |
| --- | --- | --- |
| Runtime API (with the Evidence API and the evidence forwarder) | `Dockerfile` | Yes |
| Player Shell and bundled content packages | `Dockerfile.player-shell` | Yes |
| Learner portal | `Dockerfile.learner-portal` | Yes |
| Administration workspace | `Dockerfile.admin-ui` | Yes |
| Operations console | `Dockerfile.ops-console` | Yes, restricted |
| Agent connector | `Dockerfile.mcp-connector` | Yes |

Plus one managed Postgres instance, which is the system of record for all of them.

The Evidence API runs inside the Runtime API's process rather than as a seventh service. It verifies
launch descriptors with the Runtime's signing key and writes to the same store, so splitting them
would buy independent scaling at the cost of a second copy of the key ring. Both are versioned
surfaces under `/api/v1` and can be separated later without a contract change.

## Standing up a new environment

### 1. Provision Postgres and apply the schema

```sh
export DATABASE_URL='postgres://…'
pnpm db:setup
```

Idempotent, and safe to run on every deploy: it takes an advisory lock so concurrent replicas apply
each migration once, records every applied filename, and runs each migration in its own transaction.
It prints `Database is up to date.` when there is nothing to do.

It does **not** insert example content unless `SEED_EXAMPLE_CONTENT` is set, and refuses that flag
outright when `NODE_ENV` is `production` or `staging`. A production catalogue holds what was
registered through the Publisher API and nothing else.

### 2. Generate the descriptor signing key

```sh
pnpm keys:generate
```

Put the PEM in your secret store and set `DESCRIPTOR_PRIVATE_KEY_PATH` (or
`DESCRIPTOR_PRIVATE_KEY_PEM`) and `DESCRIPTOR_KID` on **every** Runtime API replica. They must all
hold the same key: a descriptor issued by one replica has to verify on another.

### 3. Generate the pseudonym secret

```sh
openssl rand -hex 32
```

Set as `PSEUDONYM_TENANT_SECRET`, once per environment, and never change it casually — see
[key-rotation.md](key-rotation.md).

### 4. Register the platform with your identity provider

Create one API (audience) for the Runtime API and one application per front end. The front ends are
public clients using authorization code with PKCE, so none of them holds a client secret.

| Provider object | Configuration |
| --- | --- |
| API / audience | Identifier matching `OIDC_AUDIENCE`, for example `https://runtime.lorb.example/api` |
| Learner portal | Redirect URI = the portal origin; grant: authorization code with PKCE |
| Administration workspace | As above, plus the role claim your `ADMIN_ALLOWED_ROLES` expects |
| Operations console | As above |
| Agent connector | A separate API whose identifier is the connector's own `/mcp` URL |

The role claim is how an administrator is distinguished from a learner. Configure the provider to
emit `role` (or set `OIDC_ROLE_CLAIM`) on the tokens it mints for administrators; a token without
one gets 403 on every administration route, which is the correct outcome for a learner's token.

#### 4a. Auth0

The section above is what any provider needs. This is the same thing done in an Auth0 tenant, where
three of its defaults are the difference between a sign-in that works and one that completes and is
then rejected on every request: no refresh token unless offline access is allowed, no custom claim
unless it is namespaced, and an issuer whose trailing slash is part of the identifier.

**The API.** Applications → APIs → Create API. Its *Identifier* is what every surface sends as its
audience and what the Runtime API checks: put it in `OIDC_AUDIENCE` and in each front end's
`VITE_OIDC_AUDIENCE`. Signing algorithm RS256, which `OIDC_ALGORITHMS` already accepts. Turn on
**Allow Offline Access**: without it Auth0 mints no refresh token, and the administration area can
only recover an expired session by sending the teacher back to the provider — losing whatever they
had typed, which for the assistant-linking form is the whole of the work.

**The applications.** One Single Page Application per front end — learner portal, administration
workspace, operations console — each with Allowed Callback URLs, Allowed Web Origins and Allowed
Logout URLs set to that surface's own origin. No client secret: a public client in a browser cannot
keep one. Refresh Token Rotation on. Nothing needs to be overridden in the client configuration,
because the endpoints the platform calls (`/authorize`, `/oauth/token`, `/v2/logout?client_id&returnTo`)
are Auth0's own shapes and are what `OidcClient` uses by default.

**The role claim, which Auth0 will not deliver by default.** Auth0 drops custom claims that are not
namespaced, silently: a claim named `role` never reaches the token, and every administration route
answers 403 to a teacher who signed in perfectly well. Assign the role in Auth0's RBAC, then add a
post-login Action that copies it onto the access token under a namespaced name:

```js
exports.onExecutePostLogin = async (event, api) => {
  const roles = event.authorization?.roles ?? [];
  if (roles.length) api.accessToken.setCustomClaim('https://lorb.example/role', roles);
};
```

and point the platform at that name:

```
OIDC_ROLE_CLAIM=https://lorb.example/role
ADMIN_ALLOWED_ROLES=admin
```

The claim may be a single string or an array of assigned roles; both are read. The same namespacing
applies to `OIDC_PLATFORM_ADMIN_CLAIM`, which must arrive as a boolean `true`.

**The trailing slash, which is load-bearing.** Auth0's issuer is `https://your-tenant.eu.auth0.com/`
*with* the slash, and an issuer is matched byte for byte — it is an identifier, not a base URL. An
`OIDC_ISSUER` missing that slash rejects every token with `AUTHENTICATION_EXPIRED`, which reads on
screen as an expired session rather than as a configuration error, and does so from the first
request. Take the value from a decoded token's `iss` claim rather than from the dashboard heading.
`OIDC_JWKS_URL` can stay unset: it is derived correctly from the issuer either way.

**The agent connector** needs its own API, whose identifier is the connector's `/mcp` URL. Its
`OIDC_ISSUER` is the same tenant issuer, trailing slash included.

Two settings worth choosing deliberately rather than accepting: the API's **token expiration**, which
is a day by default and is what decides how often a teacher meets the re-authentication prompt
mid-task; and, if you enable RBAC on the API, **Add Permissions in the Access Token**, which the
platform reads as scopes.

Once the API exists, mint one token and read what it actually says, rather than transcribing values
from the dashboard. Authorize a machine-to-machine application for the API to get the credentials
below; the alternative is diagnosing a 401 that names none of these fields:

```sh
TOKEN=$(curl -s https://your-tenant.eu.auth0.com/oauth/token \
  -H 'content-type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"…","client_secret":"…",
       "audience":"https://runtime.lorb.example/api"}' | jq -r .access_token)
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{iss, aud, exp}'
```

`iss` is `OIDC_ISSUER` exactly as printed, trailing slash and all; `aud` is `OIDC_AUDIENCE`. A
client-credentials token carries no user and so no role claim — to check that, sign in as a teacher
in the portal and read the same fields out of the token the browser holds.

### 5. Configure and start the Runtime API

Every setting is listed in `.env.example`. The ones a production process refuses to start without:

```
NODE_ENV=production
DATABASE_URL=…
PSEUDONYM_TENANT_SECRET=…                 # 32 bytes, hex
DESCRIPTOR_PRIVATE_KEY_PATH=… + DESCRIPTOR_KID=…
RUNTIME_PUBLIC_ISSUER=https://…
PLAYER_SHELL_ORIGIN=https://…
ALLOWED_CONSUMER_ORIGINS=https://…        # exact origins, no wildcards, no built-in defaults
OIDC_ISSUER=https://…                     # byte-for-byte as the provider reports it
OIDC_AUDIENCE=…
LRS_ENDPOINT=https://…
LRS_BEARER_TOKEN=… (or LRS_BASIC_USERNAME + LRS_BASIC_PASSWORD)
RUNTIME_INTERNAL_SERVICE_TOKEN=…          # ≥32 characters, different from the agent token
```

Start it and confirm:

```sh
curl -sf https://runtime.lorb.example/health   # {"status":"ok"}
curl -s  https://runtime.lorb.example/ready    # checks.store must be "ok", persistence "postgres"
curl -s  https://runtime.lorb.example/api/v1/runtime/jwks | jq '.keys[].kid'
```

The `kid` must be the one you configured. If it is `ephemeral-dev-key`, the process is not running
with `NODE_ENV=production` — stop and fix that before anything else.

### 6. Build and deploy the front ends

Each image takes its integration values as build arguments and refuses to build without them. Every
one of them is public: an OIDC client id identifies a public client, which is what a browser
application has to be.

```sh
docker build -f Dockerfile.learner-portal \
  --build-arg VITE_ENVIRONMENT_LABEL=PRODUCTION \
  --build-arg VITE_RUNTIME_API_BASE=https://runtime.lorb.example/api/v1/runtime \
  --build-arg VITE_JWKS_URL=https://runtime.lorb.example/api/v1/runtime/jwks \
  --build-arg VITE_PLAYER_SHELL_ORIGIN=https://player.lorb.example \
  --build-arg VITE_ALLOWED_SHELL_ORIGINS=https://player.lorb.example \
  --build-arg VITE_OIDC_ISSUER=https://tenant.eu.auth0.com/ \
  --build-arg VITE_OIDC_CLIENT_ID=… \
  --build-arg VITE_OIDC_REDIRECT_URI=https://learn.lorb.example \
  --build-arg VITE_OIDC_AUDIENCE=https://runtime.lorb.example/api \
  .
```

The build fails if `VITE_ENVIRONMENT_LABEL` is not one of `PRODUCTION`, `STAGING`, `DEVELOPMENT`; if
the shell origin allow-list is empty or contains a wildcard; or if the label is anything other than
`DEVELOPMENT` and no identity provider is configured. That last check is what stops a deployed
portal falling back to the local sign-in, which accepts any subject you name.

### 7. Register content

A new catalogue is empty. Register the first learning object through the Publisher API, as an
administrator:

```sh
curl -X POST https://runtime.lorb.example/api/v1/publisher/learning-objects \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"repository_id":"…","title":"Ratios and proportion","module_path":"/module/index.html",
       "semver":"1.0.0","sha256":"…"}'
```

Publishing a later version is `POST …/{objectId}/versions`. It never modifies the previous package
version: it inserts a new immutable one and supersedes the old, so a descriptor that pinned the old
version still describes what was actually delivered.

## Deploying a new version

1. Apply migrations first: `pnpm db:setup:production`. Migrations here are additive — new tables and
   nullable columns — so the previous version keeps running against the new schema while replicas
   roll.
2. Roll the Runtime API replicas. Attempt state is in Postgres, so a replica leaving mid-request
   costs that request and nothing else. Shutdown is graceful: in-flight requests finish before the
   process exits.
3. Roll the front ends. They are static bundles behind a CDN or nginx; nothing coordinates with the
   API roll.

Watch `/ready` through the roll, and `lorb_evidence_forwarded_total{outcome="delivered"}` after it —
the forwarder is the part most likely to be affected by a network or credential change.

## Rolling back

Redeploy the previous image. Do **not** roll migrations back: the schema is additive, so the previous
version runs against the newer schema unchanged, and a down-migration would drop columns the newer
version's rows still use. If a migration itself is the problem, write a new forward migration.
