# Auth0 provisioning

Standing the tenant's API resources and applications back up, and provisioning Auth0 as the
platform's identity provider for people as well as agents.

Two independent jobs live here, and the order matters only in that the first is already half done:

| Part | What it covers | Blast radius |
| --- | --- | --- |
| [Part A](#part-a--the-mcp-connector) | The agent connector's API and the Claude custom connector | The agent surface only |
| [Part B](#part-b--identity-provision-for-people) | Runtime API, learner portal, admin UI, ops console | Every human sign-in |

Everything in Part A is tenant configuration; the connector's own settings on Railway survived and
should not be edited. Part B is tenant configuration **plus** a Railway variable change **plus** a
front-end rebuild, because the front ends take their provider at build time.

## What the deployment looks like now

Read this before changing anything: the recovery only makes sense against the state that is actually
running.

| Surface | URL | Identity today |
| --- | --- | --- |
| Agent connector | `https://mcp-connector-production-95c2.up.railway.app` | Auth0, `AUTH_MODE=oidc` — configured and running |
| Runtime API | `https://lorb-production-api.up.railway.app` | `IES_ISSUER` / `IES_JWKS_URL` — the bundled development provider |
| Learner portal (Consumer UI) | `https://lorb-production-consumer.up.railway.app` | No `VITE_OIDC_*` — development sign-in |
| Admin UI | `https://lorb-production-beda.up.railway.app` | As above |
| Ops console | `https://lorb-production-console.up.railway.app` | As above |
| Player shell | `https://lorb-production-shell.up.railway.app` | No sign-in of its own |
| Development identity provider | `https://lorb-production-ies.up.railway.app` | The thing Part B replaces |

Tenant: `dev-8hzrbclkyzw1l512.us.auth0.com`. The connector's running process reports its
configuration on start-up, which is the fastest way to confirm the two values that matter:

```
LORB MCP connector 0.1.0: OIDC resource-server mode — validating tokens from
https://dev-8hzrbclkyzw1l512.us.auth0.com/ for audience
https://mcp-connector-production-95c2.up.railway.app/mcp.
```

Those two strings are what the tenant has to be rebuilt to match. **The issuer's trailing slash is
part of it** — `iss` is compared byte for byte.

---

## Part A — the MCP connector

The connector is an OAuth resource server and nothing else: it verifies a JWT against the tenant's
JWKS and publishes RFC 9728 metadata. It issues nothing, stores no credential, and holds no client
secret. So losing the tenant's API resource breaks it completely, and rebuilding the tenant fixes it
completely — with no deployment on our side.

Do these in order. Each failure only surfaces once the previous one is fixed, and none of the error
messages names its cause.

### A1. Create the API

Applications → APIs → **Create API**.

| Field | Value |
| --- | --- |
| Name | `LORB MCP connector` (free text) |
| Identifier | `https://mcp-connector-production-95c2.up.railway.app/mcp` |
| Signing algorithm | RS256 |

The identifier must be that exact URL. It is opaque to Auth0, but a client checks that the `resource`
in our metadata matches what it was trying to reach, and it is what `OIDC_AUDIENCE` on the connector
already expects. Auth0 will not let you edit an identifier afterwards — a wrong one means delete and
recreate.

> Do **not** point this at `https://dev-8hzrbclkyzw1l512.us.auth0.com/api/v2/`. That is the
> Management API — the one that administers the tenant — and it is the only API a fresh tenant has,
> so it is the one you find if you go looking. It would accept any tenant-administration token, and
> would have Claude asking users for tenant-administration credentials to draft a quiz.

### A2. Define a permission

The new API → **Permissions** → add `lorb.teacher` with any description.

This looks optional and is not: A3 is a choice of *which* permissions third-party applications get,
and with none defined there is nothing to grant.

### A3. Authorise third-party applications

The API → Settings → **Default Permissions for Third-Party Applications** → *Authorized for
User-Delegated Access*.

A dynamically registered client is a third-party application, and third-party applications get no API
access by default.

*Symptom if skipped:* `invalid_request: Client "tpc_…" is not authorized to access resource server
"https://…/mcp"`, at the authorize step, before any login screen.

### A4. Allow a connection to serve third-party clients

Authentication → Database → `Username-Password-Authentication` → **Enable for third-party clients**
(labelled *Promote to domain level* in some tenants).

Without it the dynamically registered client has no way to authenticate anybody.

### A5. Enable dynamic registration, and set the Default Audience

- Settings → Advanced → **OIDC Dynamic Application Registration** → on.
- Settings → General → API Authorization Settings → **Default Audience** →
  `https://mcp-connector-production-95c2.up.railway.app/mcp`.

Without the Default Audience, Auth0 returns an **opaque** access token instead of a JWT, and the
connector — which verifies a signature — rejects it. The symptom is a 401 *after* an apparently
successful login, which sends you looking in the wrong place entirely.

> **Default Audience is tenant-wide, and Part B adds a second API.** Once the runtime API exists,
> every client that asks for no audience gets a connector token. The front ends in Part B all request
> an explicit `audience`, so they are unaffected — but if you later add a client that relies on the
> default, this is the setting that decides what it gets.

### A6. Confirm the connector's settings — do not change them

Nothing to deploy. Verify on Railway (project *LORB API*, service `mcp-connector`) that these are
still set, and leave them alone:

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `oidc` |
| `OIDC_ISSUER` | `https://dev-8hzrbclkyzw1l512.us.auth0.com/` — **with** the trailing slash |
| `OIDC_AUDIENCE` | `https://mcp-connector-production-95c2.up.railway.app/mcp` |
| `MCP_PUBLIC_URL` | `https://mcp-connector-production-95c2.up.railway.app` |
| `MCP_SHARED_BEARER_TOKEN` | must be **absent** — the connector refuses to start with it in `oidc` mode |
| `OIDC_REQUIRED_SCOPE` | leave unset (see below) |

`OIDC_JWKS_URL` is derived from the issuer and need not be set. Leave `OIDC_REQUIRED_SCOPE` unset: a
client that requests only OIDC scopes carries no API permission, so setting it would 403 every token
until the client asks for `lorb.teacher` specifically.

### A7. Reconnect Claude

claude.ai → Settings → Connectors → **Add custom connector** →
`https://mcp-connector-production-95c2.up.railway.app/mcp`.

The flow is: 401 challenge → RFC 9728 discovery → dynamic client registration → login and consent →
a JWT the connector verifies.

**Make one attempt.** Every attempt that reaches the authorize step has already completed a dynamic
registration and created a `tpc_…` third-party application named "Claude". Half a dozen retries
exhausts the tenant's application quota, after which registration itself starts failing:

```
403 {"errorCode":"too_many_entities",
     "message":"You reached the limit of entities of this type for this tenant."}
```

That failure looks like a regression — it worked, now it does not, nothing changed. If you hit it,
delete the accumulated `tpc_…` applications in Applications → Applications. It is also worth knowing
that with DCR enabled, `/oidc/register` is open to unauthenticated callers, so that quota is a
denial-of-service vector: acceptable for a proof of concept, not for anything real, and the reason to
weigh pre-registering a single client against leaving DCR on.

### A8. Verify

1. `curl -s https://mcp-connector-production-95c2.up.railway.app/health` → `"auth_mode":"oidc"`.
2. `curl -s https://mcp-connector-production-95c2.up.railway.app/.well-known/oauth-protected-resource/mcp`
   → `resource` is the `/mcp` URL, `authorization_servers` names the tenant.
3. In Claude, ask the assistant to call `whoami`. It reports the issuer and subject exactly as LORB
   authenticated them, plus whether that principal is linked to a teacher.
4. Link that principal in the portal's administration area — Issuer
   `https://dev-8hzrbclkyzw1l512.us.auth0.com/`, Subject `auth0|…`. Until it is linked, `list_classes`
   returns empty and every `class://` read 404s. **That is the scoping working, not a fault.**

### Diagnosing a failure

The connector's logs answer very little here. The tenant log answers almost everything: Auth0
Dashboard → Monitoring → Logs, newest entry, read `description`.

| What the log says | What it means |
| --- | --- |
| `Service not found: https://…/mcp` | No API has that exact identifier (A1) |
| `Client "tpc_…" is not authorized to access resource server` | Third-party access not granted (A2–A3) |
| Anything naming a connection | No domain-level connection (A4) |
| A 401 after a successful login | No Default Audience — an opaque token, not a JWT (A5) |
| `too_many_entities` from `/oidc/register` | Application quota exhausted — delete the orphaned `tpc_…` clients |

To test registration without a client in the loop:

```sh
curl -i -X POST "https://dev-8hzrbclkyzw1l512.us.auth0.com/oidc/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"dcr-test","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}'
```

A 201 creates a real application — delete it afterwards.

---

## Part B — identity provision for people

Today the deployed platform trusts the bundled development identity provider: it has no password, no
consent and no user directory, and it mints a token for whatever subject a caller names. That is
what `IES_ISSUER` on the Runtime API points at, and why the front ends still carry
`VITE_DEVELOPMENT_LOGIN_URL`. Teacher sign-in now goes through the provider like the learner path
does, so the provider is the only remaining thing standing between a deployed URL and anybody's
class data.

Part B replaces it with the same Auth0 tenant. The connector's API is **not** reused: a second API
means a token minted for the quiz connector cannot open the Runtime API, and vice versa. That
separation is the point.

### B1. Create the Runtime API resource

Applications → APIs → **Create API**.

| Field | Value |
| --- | --- |
| Name | `LORB Runtime API` |
| Identifier | `lorb-runtime` |
| Signing algorithm | RS256 |

`lorb-runtime` is the value the Runtime API already expects as `OIDC_AUDIENCE`, and it is what the
front ends will request. Then, on that API:

- Settings → **Allow Offline Access** → **on**. Without it Auth0 issues no refresh token, and an
  administration session that expires mid-form sends the teacher back through a redirect that loses
  whatever they had typed. The portal's `renew()` exists precisely to avoid that.
- Settings → Token Expiration — 24 hours (86400) is the default and is fine; the portal renews early.
- RBAC → **Enable RBAC** and **Add Permissions in the Access Token** if you intend to use scopes
  later. Neither is required for the role check below, which reads a claim rather than a scope.

### B2. Emit the role claim

LORB reads a teacher's role from a claim, and refuses the administration surfaces without it —
`ADMIN_AUDIT_DENIED`, from the API, never from the front end. Auth0 will not put a bare `role` claim
in a token: custom claims must be namespaced or they are silently dropped. So the claim name is
configuration on our side, and an Action on theirs.

1. User Management → Roles → create `teacher` (and `platform-admin` if you want the bypass).
   Assign users to them.
2. Actions → Library → **Build Custom** → *Login / Post Login* → name it `LORB role claim`:

```js
exports.onExecutePostLogin = async (event, api) => {
  const roles = event.authorization?.roles ?? [];
  if (roles.includes('teacher')) {
    api.accessToken.setCustomClaim('https://lorb.dev/role', 'admin');
  }
  if (roles.includes('platform-admin')) {
    api.accessToken.setCustomClaim('https://lorb.dev/platform_admin', true);
  }
};
```

3. Deploy it, then Actions → Triggers → `post-login` → drag it into the flow.

The claim value is `admin` because that is what `ADMIN_ALLOWED_ROLES` accepts. Two equally good
alternatives, if you prefer: set the claim to `teacher` and set `ADMIN_ALLOWED_ROLES=teacher`, or emit
the roles array unchanged — the verifier tolerates a plain string or an array of strings, because
Auth0 and Entra both emit the latter for role assignments.

`https://lorb.dev/` is a namespace, not an address; it is never fetched. Use any URI you will not
confuse later, and use the same one in `OIDC_ROLE_CLAIM`.

### B3. Create one application per front end

Applications → Applications → **Create Application** → *Single Page Web Application*, three times.
Each is a public client using authorization code with PKCE — no client secret, because a browser
cannot keep one.

| Application | Allowed Callback URL, Logout URL, Web Origin |
| --- | --- |
| `LORB Learner Portal` | `https://lorb-production-consumer.up.railway.app` |
| `LORB Admin UI` | `https://lorb-production-beda.up.railway.app` |
| `LORB Ops Console` | `https://lorb-production-console.up.railway.app` |

For each application, set **all three** of Allowed Callback URLs, Allowed Logout URLs and Allowed Web
Origins to that origin, with no trailing slash and no path. The portal's callback lands on the origin
itself — one redirect URI serves both the learner and teacher sign-ins, which is why the code carries
its own intent marker to tell them apart.

Then, on each application:

- Settings → Advanced → Grant Types → `Authorization Code` and `Refresh Token` checked, `Implicit`
  unchecked. A token in a URL fragment ends up in history, referrers, and whatever reads the address
  bar.
- Settings → Refresh Token Rotation → **on**, with reuse interval 0. Rotation is what makes a refresh
  token in a browser defensible at all.
- Token Endpoint Authentication Method → `None`.

Do **not** add the player shell. It has no sign-in of its own; it opens a signed descriptor.

### B4. Reconfigure the Runtime API

Railway → project *LORB API* → service `LORB`. Set:

| Variable | Value |
| --- | --- |
| `OIDC_ISSUER` | `https://dev-8hzrbclkyzw1l512.us.auth0.com/` |
| `OIDC_JWKS_URL` | leave unset — derived from the issuer |
| `OIDC_AUDIENCE` | `lorb-runtime` |
| `OIDC_ALGORITHMS` | `RS256` |
| `OIDC_ROLE_CLAIM` | `https://lorb.dev/role` |
| `OIDC_PLATFORM_ADMIN_CLAIM` | `https://lorb.dev/platform_admin` |
| `ADMIN_ALLOWED_ROLES` | `admin` |
| `ALLOWED_CONSUMER_ORIGINS` | the three front-end origins, comma-separated, no wildcard |
| `NODE_ENV` | `production` |
| `ALLOW_SYNTHETIC_IDENTITY` | **remove it** (or `false`) |

Delete `IES_ISSUER`, `IES_JWKS_URL`, `STUB_IES_ISSUER` and `STUB_IES_JWKS_URL` once the switch is
confirmed — `OIDC_ISSUER` takes precedence while both are present, so they are inert rather than
dangerous, but leaving them invites a later rollback to a provider that authenticates nobody.

`ALLOW_SYNTHETIC_IDENTITY` with `NODE_ENV=production` fails start-up outright, with every problem
named at once. A crash-looping replica after this change is almost always that line — read the
`refusing to start: invalid configuration` output before changing anything else.

### B5. Rebuild the front ends

These are **build arguments**, not runtime variables: Vite substitutes them into the bundle, so a
change means a rebuild and redeploy, not a variable edit. None of them is a credential — a client id
identifies a public client, which is what a browser application has to be.

For the learner portal (project *LORB Consumer UI*):

```
VITE_ENVIRONMENT_LABEL=PRODUCTION
VITE_OIDC_ISSUER=https://dev-8hzrbclkyzw1l512.us.auth0.com/
VITE_OIDC_CLIENT_ID=<the Learner Portal application's client id>
VITE_OIDC_REDIRECT_URI=https://lorb-production-consumer.up.railway.app
VITE_OIDC_AUDIENCE=lorb-runtime
VITE_RUNTIME_API_BASE=https://lorb-production-api.up.railway.app/api/v1/runtime
VITE_ADMIN_API_BASE=https://lorb-production-api.up.railway.app/api/v1/admin
VITE_JWKS_URL=https://lorb-production-api.up.railway.app/api/v1/runtime/jwks
VITE_PLAYER_SHELL_ORIGIN=https://lorb-production-shell.up.railway.app
VITE_ALLOWED_SHELL_ORIGINS=https://lorb-production-shell.up.railway.app
```

Same shape for the admin UI and the ops console, each with its own client id and its own origin as
the redirect URI. Drop `VITE_DEVELOPMENT_LOGIN_URL`, `VITE_DEVELOPMENT_IDENTITY_ISSUER`,
`VITE_STUB_IES_ISSUER` and `VITE_STUB_IES_LOGIN_URL` in the same rebuild.

The build refuses a label outside `PRODUCTION | STAGING | DEVELOPMENT`, an empty or wildcard shell
origin allow-list, and — the one that matters here — any non-`DEVELOPMENT` label with no provider
configured. That last check is what stops a deployed portal falling back to a sign-in that accepts
any subject you name, and it is why the label and the `VITE_OIDC_*` values have to move together.

### B6. Verify, in this order

1. `curl -sf https://lorb-production-api.up.railway.app/health` → `{"status":"ok"}`. If the replica
   is crash-looping, read the configuration refusal.
2. Open the portal. You are redirected to Auth0 and back; the URL has no `code` left in it.
3. Choose **Continue as a teacher**. That is a second round trip through the same provider and the
   same redirect URI, and it must land in the administration area rather than the catalogue.
4. As an account **without** the `teacher` role, confirm the administration area is refused. That
   refusal comes from the API reading the claim — it is the control working.
5. As one **with** it, confirm classes load. An error here is almost always an origin missing from
   `ALLOWED_CONSUMER_ORIGINS`.
6. Leave the administration area idle past the access token's lifetime, then act. It should renew in
   place without a redirect. If it redirects instead, Allow Offline Access (B1) or the Refresh Token
   grant (B3) is off.
7. Confirm there is no environment notice in a `PRODUCTION` build.

### B7. Learner identifiers

A learner's roster identifier must match the subject the provider issues for that learner — that is
what the pseudonymisation function keys on. Adding learners under a stub identifier and switching
providers afterwards renames every one of them, and their historical evidence stops resolving to the
same person. Settle the identifier scheme before enrolling anybody real.

### Rolling back

Part B is reversible until learners sign in under Auth0 subjects. Restore `IES_ISSUER` /
`IES_JWKS_URL`, remove `OIDC_ISSUER`, set `ALLOW_SYNTHETIC_IDENTITY=true` and `NODE_ENV` back, and
rebuild the front ends with `VITE_ENVIRONMENT_LABEL=DEVELOPMENT` and no `VITE_OIDC_*`. After learners
have signed in, rolling back re-pseudonymises them — treat the switch as one-way from that point, and
see [key-rotation.md](key-rotation.md) for why.

Part A rolls back to nothing: without the tenant's API resource the connector simply refuses tokens.
There is no `shared-token` fallback in a deployed environment, deliberately — it is refused outright
when `NODE_ENV` is production or staging.

---

## What none of this decides

Authentication is not authorization, and neither is a privacy design. Auth0 establishes *who is
calling*; the agent-principal link establishes *what an assistant may see*; the role claim establishes
who may administer. What a teacher's assistant should be allowed to do with a class's outcomes is a
policy question for whoever owns learner data at the institution. Answer it before pointing this at
real classes, not after.
