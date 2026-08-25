# Agent connector

A remote MCP server (streamable HTTP transport) that lets a teacher's AI agent draft a quiz, register
it as a LORB learning object, assign it to a class, and read back aggregated results — through LORB's
real Runtime and Evidence pipeline, not a mock of it.

## Two trust domains, kept apart

| | Agent-facing (this package) | Learner-facing (existing) |
|---|---|---|
| Principal | The teacher's agent session | One learner, one launch |
| Credential | A token from your identity provider, `AUTH_MODE=oidc` | A token from the same provider, `aud: lorb-runtime` |
| Lifetime | The provider's | Minutes |
| Scope | One teacher's classes, through an explicit link | One learner, one launch |

They share no token, no scope, and no signing key. The agent's token never reaches a launch descriptor
or a learner access token, and a learner token is never accepted here. Configuration refuses to start
if the agent credential and the Runtime internal-service credential are the same value.

### Two authentication modes

| | `AUTH_MODE=oidc` (default) | `AUTH_MODE=shared-token` |
|---|---|---|
| Credential | A token issued by an identity provider you already run | One pre-shared bearer token per environment |
| Validated by | Signature against the provider's JWKS, plus `iss`, `aud` and expiry | Constant-time comparison |
| Discovery | RFC 9728 metadata at `/.well-known/oauth-protected-resource` | None |
| Suitable for | Every deployed environment | Local development and continuous integration only |

`shared-token` is refused outright when `NODE_ENV` is `production` or `staging`: a single pre-shared
token has no identity behind it, cannot be scoped to one teacher, cannot be revoked for one agent, and
names nobody in an audit record. `poc` is still accepted as the previous name for this mode, so an
existing development environment keeps working without an edit.

**In `oidc` mode this connector is an OAuth resource server and nothing else.** It validates tokens
and publishes metadata. It never issues, refreshes, stores, or exchanges a credential, and it holds
no client secret — whoever runs the identity provider remains the only issuer of identity. That is
the whole point: the hardest part of authorization stays with a system built for it.

Configure it against Auth0, Entra, Google Workspace, Keycloak, or anything else that publishes a
JWKS:

```
AUTH_MODE=oidc
OIDC_ISSUER=https://your-tenant.example.com      # expected `iss`
OIDC_AUDIENCE=https://your-connector/mcp         # expected `aud` — see below
MCP_PUBLIC_URL=https://your-connector            # for the RFC 9728 `resource` value
OIDC_JWKS_URL=...                                # optional; defaults to the issuer's standard path
OIDC_REQUIRED_SCOPE=lorb.teacher                 # optional scope gate
```

**`OIDC_AUDIENCE` is required and never derived.** It is the check that stops a token the same
provider minted for *some other service in the same tenant* from opening this one — the
confused-deputy problem the MCP authorization specification calls out. Making it explicit means it
cannot be quietly forgotten. Register this connector as its own API/resource in your provider and use
that identifier.

Three further guards, all fail-closed at start-up: the issuer must be `https`; the pre-shared token
must be **absent** in `oidc` mode, so it cannot linger as a second, weaker way past the provider; and
`shared-token` mode is refused in production regardless of what else is configured.

### Wiring it to Auth0

Auth0 is the provider this has been shaped against, because it is the one of the common three that
implements dynamic client registration. Entra does not implement RFC 7591 and Microsoft has said it
is not on the roadmap; Google Workspace does not either. With those two you pre-register a client
and paste its ID into the connector settings by hand.

Everything below except step 6 is tenant configuration rather than code. It is written in the order
you hit the failures, because each one only surfaces after the previous is fixed, and none of the
error messages name the cause.

**1. Create an API.** Applications → APIs → Create API. Set the **Identifier** to the connector's
MCP endpoint — `https://<connector-host>/mcp`. The identifier is an opaque string to Auth0, but a
client checks that the `resource` field in our metadata matches the resource it was trying to
reach, so making it anything else invites a mismatch. This value becomes `OIDC_AUDIENCE`.

> Do **not** use `https://<tenant>/api/v2/`. That is the built-in Management API — the one that
> administers the tenant — and it is the only API a fresh tenant has, so it is the one you find if
> you go looking. Pointing the connector at it would accept any tenant-administration token, and
> would have clients requesting tenant-administration credentials to talk to a quiz service.

> Auth0 does not let you edit an Identifier after creation. If it is wrong, delete the API and
> create another.

**2. Define at least one permission.** The new API → Permissions → add e.g. `lorb.teacher`. This
looks optional and is not: step 3 is a choice of *which permissions* third-party applications get
by default, and with none defined there is nothing to grant.

**3. Authorise third-party applications.** The API → Settings → **Default Permissions for
Third-Party Applications** → *Authorized for User-Delegated Access*. A dynamically registered
client is a third-party application, and third-party applications get no API access by default.

*Symptom if skipped:* `invalid_request: Client "tpc_…" is not authorized to access resource server
"https://…/mcp"`, at the authorize step, before any login screen.

**4. Allow a connection to serve third-party clients.** Authentication → Database →
`Username-Password-Authentication` → **Enable for third-party clients** (labelled *Promote to
domain level* in some tenants). Without it the client has no way to authenticate anyone.

**5. Enable dynamic client registration** and **set a Default Audience.** Settings → Advanced →
*OIDC Dynamic Application Registration*; then Settings → General → API Authorization Settings →
*Default Audience* → the identifier from step 1.

Without the Default Audience, Auth0 returns an **opaque** access token rather than a JWT, and this
connector — which verifies a JWT signature — rejects it. The symptom is a 401 *after* an
apparently successful login, which sends you hunting in the wrong place.

**6. Configure the connector.** `OIDC_ISSUER` must carry its **trailing slash**: Auth0 mints `iss`
as `https://<tenant>.<region>.auth0.com/` and the claim is compared byte for byte. Copy it exactly
as the tenant's discovery document reports it. `OIDC_JWKS_URL` is derived and need not be set.
`OIDC_REQUIRED_SCOPE` is optional; note that a client requesting only OIDC scopes will not carry
your API permission, so setting it will 403 every token unless the client asks for that scope.

#### Two things that will bite you

**Every failed connector attempt consumes an Auth0 application slot.** Each attempt that reaches
the authorize step has already completed a dynamic registration and created a third-party client.
Retry a failing setup half a dozen times and the tenant hits its application limit, at which point
registration itself starts failing:

```
403 {"errorCode":"too_many_entities",
     "message":"You reached the limit of entities of this type for this tenant."}
```

The failure then looks like a regression — it worked, now it does not, and nothing was changed.
The fix is to delete the accumulated `tpc_…` applications named "Claude" in Applications →
Applications. The lesson is to fix the tenant configuration and make *one* attempt, rather than
retrying on failure.

**That limit is a denial-of-service vector.** Once DCR is enabled, `/oidc/register` is open to
unauthenticated callers. An attacker does not need to authenticate to anything: they call it in a
loop until the tenant's application quota is exhausted, after which no legitimate client can
register. For a proof of concept that is a known and accepted exposure. It is not acceptable for
anything real, and it is a reason to weigh pre-registering a single client against enabling DCR at
all.

#### Diagnosing a failure

The connector's own logs answer very little here; the tenant log answers almost everything. Auth0
Dashboard → Monitoring → Logs, newest entry, read `description`.

| What the log says | What it means |
|---|---|
| `Service not found: https://…/mcp` | No API in the tenant has that exact Identifier (step 1) |
| `Client "tpc_…" is not authorized to access resource server` | Third-party access not granted (steps 2–3) |
| Anything naming a connection | No domain-level connection (step 4) |
| `too_many_entities` from `/oidc/register` | Application quota exhausted — delete the orphaned clients |

To test registration directly, without going through a client:

```
curl -i -X POST "https://<tenant>/oidc/register" -H "Content-Type: application/json" \
  -d '{"client_name":"dcr-test","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}'
```

A 201 creates a real application — delete it afterwards. The status line is half the answer.

### What `oidc` mode does and does not buy you

It makes the connector a valid OAuth resource server, which is the half of the problem that belongs
in this repository. Whether a given client can then complete a flow depends on the provider: Claude
needs dynamic client registration, client ID metadata documents, or a client you pre-register and
paste in. That is a decision about your identity provider, not about this code.

What it does not do is decide who may use the connector. That is your provider's job, and keeping it
there is deliberate: the hardest part of authorization stays with a system built for it.

### Agent principals and roster scoping

The connector holds one internal service credential for every agent session. That credential
authenticates the *connector*, not the person using it, so on its own it cannot scope anything —
and for a time it did not: the internal roster projection served every active class to any caller
holding it, which in `oidc` mode meant any authenticated teacher could read any other teacher's
class metadata and pass those UUIDs to the `class://` resources and `assign_quiz`.

Scoping needs the agent's identity to resolve to a teacher, and it cannot be computed. A teacher's
classes are owned by `HMAC(issuer | subject | "admin")`, derived from the identity they sign into the
portal with; an agent may authenticate as a different principal, possibly through a different
provider. Nothing joins the two, deliberately — an inferred join on a matching email is exactly the
kind of quiet identity linkage that turns out to be wrong for one person in a thousand.

So the link is **explicit and teacher-created**. The connector forwards the principal it verified
(`x-lorb-agent-issuer`, `x-lorb-agent-subject`) alongside the service token; the Runtime API resolves
it through `agent_principal_link` and scopes every roster read to that teacher. It is never inferred
from a matching email or a shared claim.

It fails closed in both directions. An unlinked principal gets an empty class list and a 404 on any
class it names — including one whose UUID it already knows. `shared-token` mode is not exempt: it presents a
fixed local principal that must be linked like any other, so there is no mode-specific bypass to
forget about later.

A teacher links and revokes assistants in the portal's administration area. A principal can only
ever be linked to the classes of the teacher who linked it, and re-pointing somebody else's live
link is refused rather than silently moving an assistant's access between accounts. That ownership
condition is enforced inside the conflicting write, so two teachers claiming the same principal at
once cannot both win it.

Finding the two values is the awkward part, and it is worth being straight about: **you cannot ask
the assistant.** An MCP host keeps its access token away from the model, so the assistant does not
know which subject it is presenting, and an unlinked one can see nothing to tell you about. They
come from the identity provider instead — in Auth0, Monitoring → Logs, the `user_id` on any
successful login through this connector, with the issuer being the tenant URL including its trailing
slash.

The `whoami` tool closes that loop. Ask the assistant which principal it is connecting as and it
reports the issuer and subject exactly as LORB authenticated them, along with whether that principal
is linked yet. It returns only what is already inside the caller's own token, and never the teacher
pseudonym the link resolves to — that identifies a different person and is not needed to set one up.

Without it, a mismatched link is undiagnosable: the class list comes back empty whether the
principal is unlinked, mistyped, or linked to a teacher who simply has no classes. `whoami`
separates those cases, which is the difference between a two-minute fix and an afternoon.

## Resources

| URI | Returns |
|---|---|
| `class://{classId}` | Name, year group, subject, learner count. No learner names or identifiers. |
| `class://{classId}/recent-topics` | Recently taught topics, so generated questions are relevant. |
| `quiz://{objectId}/results` | Assigned/completed counts, mean `result.score.scaled`, not-yet-started pseudonyms — read from the Evidence API, not canned. |

Class data comes from the roster in the Runtime API's database, scoped to the teacher the calling
agent principal is linked to. The connector reads it through the internal service surface and cannot
change it: every roster write is administrator-authenticated and web-only.

## Tools

`whoami` — read-only. Reports the agent principal this connector authenticated, and whether it is
linked to a teacher. Needed because an MCP host keeps its access token away from the model, so an
assistant otherwise cannot tell anyone which identity to link.

`list_classes` — read-only. Lists the classes belonging to the teacher this agent principal is
linked to, with year group, subject and learner count, so a class can be chosen without its
identifier being known in advance. An unlinked principal gets an empty list.

It returns no learner names or identifiers: the projection behind it withholds them, and the tool
maps an explicit field list rather than passing the row through, so a leak would have to happen
twice to reach an agent. The roster is created and changed by a signed-in teacher in the Consumer
UI; nothing on this connector writes to it.

**`create_quiz`** — registers structured question data as a new learning object plus an immutable
content payload, bound to the fixed, already-reviewed `quiz-player` package version. An agent never
generates or registers a JavaScript bundle, so there is no per-quiz code-injection surface.

The tool result carries `object_id`, `package_version`, and `question_count` only. **The answer key
never leaves this tool** — no `correct_option_id`, no explanations, no option text. The marking key is
stored for the player to mark against and is served only on the learner-facing content route.

**`assign_quiz`** — the consent-critical action. Resolves the class roster, then creates a LORB
assignment by deriving one pseudonym per learner through the platform's normal pseudonymisation
function. Its description tells a compliant MCP host to confirm with the teacher before calling, and
both tools are annotated `readOnlyHint: false, destructiveHint: false`.

It requires a client-supplied `idempotency_key`. Re-calling with the same key returns the original
result with `duplicate: true` rather than re-assigning.

**Smart links are deliberately not used here.** LORB's smart-link mechanism is durable, revocable,
login-free, and binds to a pseudonymous cookie — anonymous, indefinite access is the wrong trust model
for a graded class assignment, `assign_quiz` goes through the authenticated internal launch path
instead, and never returns a launch descriptor or player URL to the agent.

## Three idempotency layers

Each guards a different hop and none replaces another:

1. **This connector** (`idempotency.ts`) — a repeated `assign_quiz` call from the agent or its host.
2. **Runtime API** — the `Idempotency-Key` required on every launch and internal batch request.
3. **Evidence API** — statement UUID deduplication in the outbox.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `AUTH_MODE` | no (`oidc`) | `oidc` or `shared-token`; any other value refuses to start, and `shared-token` is refused in production. |
| `MCP_SHARED_BEARER_TOKEN` | in `shared-token` | ≥32 characters. Must be absent when `AUTH_MODE=oidc`. |
| `OIDC_ISSUER` | in `oidc` | Expected `iss`. Must be `https`. |
| `OIDC_AUDIENCE` | in `oidc` | Expected `aud` — this resource's own identifier. |
| `MCP_PUBLIC_URL` | in `oidc` | Public base URL, for the RFC 9728 `resource` value. |
| `OIDC_JWKS_URL` | no | Defaults to `${OIDC_ISSUER}/.well-known/jwks.json`. |
| `OIDC_REQUIRED_SCOPE` | no | When set, a valid token without it gets `403 insufficient_scope`. |
| `RUNTIME_INTERNAL_SERVICE_TOKEN` | yes | ≥32 characters, must differ from the above. |
| `RUNTIME_API_BASE` | no | Default `http://localhost:3000`. |
| `EVIDENCE_API_BASE` | no | Defaults to `RUNTIME_API_BASE` — the Evidence API is mounted on the Runtime listener. |
| `ROSTER_API_BASE` | no | The roster projection. Defaults to `http://localhost:3000`, the Runtime API. |
| `PORT` / `MCP_CONNECTOR_PORT` | no | Default `4200`. |

## Endpoints

- `POST|GET|DELETE /mcp` — streamable HTTP transport, stateless (one server and transport per request).
- `GET /` — unauthenticated endpoint index.
- `GET /health` — unauthenticated liveness only.
- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 metadata, **`oidc` mode only**. This
  is the path-inserted location RFC 9728 §3.1 specifies for a resource served at `/mcp`, and the
  URL the `WWW-Authenticate` challenge points at.
- `GET /.well-known/oauth-protected-resource` — the same document at the bare well-known path, for
  clients that construct it from the origin rather than following the challenge pointer.

  Neither is served in `shared-token` mode: publishing a document pointing at an authorization server that
  does not exist would start a flow no client could finish.

## Trying it locally with Claude

> The steps below use `shared-token` mode against a local stack. That mode is refused when
> `NODE_ENV` is production or staging, so nothing here is a route to exposing the connector publicly
> — for that, configure `AUTH_MODE=oidc` against your own provider.

### 1. Generate the three secrets

Compose refuses to start without them. Export them as well as writing them to `.env` — later steps
read `$MCP_SHARED_BEARER_TOKEN` from your shell, and `.env` alone does not put it there:

```sh
export PSEUDONYM_TENANT_SECRET=$(openssl rand -hex 32)
export RUNTIME_INTERNAL_SERVICE_TOKEN=$(openssl rand -hex 32)
export MCP_SHARED_BEARER_TOKEN=$(openssl rand -hex 32)
{ echo "PSEUDONYM_TENANT_SECRET=$PSEUDONYM_TENANT_SECRET"
  echo "RUNTIME_INTERNAL_SERVICE_TOKEN=$RUNTIME_INTERNAL_SERVICE_TOKEN"
  echo "MCP_SHARED_BEARER_TOKEN=$MCP_SHARED_BEARER_TOKEN"; } >> .env
```

In a **new** shell later on, load them back with `set -a; . ./.env; set +a` rather than regenerating
them — new tokens would not match the running containers.

### 2. Start the stack

```sh
docker compose up -d
```

That brings up Postgres, the Runtime API (`:3000`, with the Evidence routes mounted on it), the
development identity provider (`:4000`), the development learning record store (`:5000`), the Player
Shell (`:3200`), and this connector (`:4200`).

<details>
<summary>Without Docker: run the Node entrypoints directly</summary>

Each server runs in the foreground, so background them (or use several terminals). You need a Postgres
reachable at `DATABASE_URL` with `pnpm db:setup` already applied. The environment below is not
optional: without `EVIDENCE_API_ENDPOINT` the Runtime API issues descriptors pointing somewhere
nothing listens, and learner evidence would be posted into the void instead of reaching the results
read model.

```sh
pnpm install && pnpm build
set -a; . ./.env; set +a   # loads the three secrets from step 1

PORT=4000 IES_PUBLIC_ISSUER=http://localhost:4000 \
  node dist/packages/dev-identity/src/server.js &
PORT=5000 \
  node dist/packages/dev-lrs/src/server.js &
PORT=3000 RUNTIME_PUBLIC_ISSUER=http://localhost:3000 \
  PLAYER_SHELL_ORIGIN=http://localhost:3200 \
  EVIDENCE_API_ENDPOINT=http://localhost:3000/api/v1/evidence/statements \
  OIDC_ISSUER=http://localhost:4000 ALLOW_SYNTHETIC_IDENTITY=true \
  LRS_ENDPOINT=http://localhost:5000 \
  SEED_EXAMPLE_CONTENT=true \
  node dist/src/server.js &
PORT=4200 AUTH_MODE=shared-token RUNTIME_API_BASE=http://localhost:3000 \
  EVIDENCE_API_BASE=http://localhost:3000 \
  ROSTER_API_BASE=http://localhost:3000 \
  node dist/packages/mcp-connector/src/server.js &
```

Stop them again with `kill %1 %2 %3 %4`. The Player Shell is not included — it is a static bundle, and
nothing up to step 4 needs a browser.

</details>

Check they all came up:

```sh
for p in 4000 5000 3000 4200; do printf 'port %s: ' $p; curl -s localhost:$p/health; echo; done
```

The connector reports `{"status":"ok", … "auth_mode":"shared-token","environment":"development"}`.

### 3. Connect Claude Code

Claude Code speaks the streamable HTTP transport and can send a static header, which is what this
connector's pre-shared bearer mode needs:

```sh
claude mcp add --transport http lorb http://127.0.0.1:4200/mcp \
  --header "Authorization: Bearer $MCP_SHARED_BEARER_TOKEN"
claude mcp list          # -> lorb: http://127.0.0.1:4200/mcp (HTTP) - Connected
```

Then ask Claude something like:

> Read the recent topics for class `9c1f0a5e-7d2b-4f83-9a6c-2b8e5d4a1c30`, draft a five-question quiz
> on the most recent one, and create it. Don't assign it yet.

Create a class first in the portal's administration area, add a learner or two, record a taught
topic, and link your assistant's principal to your account — an unlinked principal sees nothing, which
is the scoping working rather than a fault. `whoami` tells you which principal to link.

`assign_quiz` is the consent-gated step: its description tells a compliant host to confirm with the
teacher first, so expect Claude to ask before calling it. After assigning, read
`quiz://{objectId}/results` — it will show the class assigned, nobody started, and no average yet
until learners actually sit the quiz.

### 4. Poke it by hand instead

`npx @modelcontextprotocol/inspector` accepts a URL and a bearer token, and is the quickest way to see
raw `tools/list` and `resources/read` traffic without an agent in the loop.

### claude.ai and Claude Desktop custom connectors

These need a **public HTTPS URL** and discover authorization over OAuth, so they require `oidc`
mode. In `shared-token` mode they cannot work at all: there is no authorization server to discover, no
metadata document is served, and neither UI has a field for a static bearer header. The registration
failure they report — *"Couldn't register with … sign-in service"* — is the absence of that
discovery chain, not a fault in the client.

In `oidc` mode, against an Auth0 tenant configured as above, the full flow works: 401 challenge →
RFC 9728 discovery → dynamic client registration → login and consent → a JWT this connector
verifies. That has been exercised end to end against a live deployment.

Authentication is not authorization, and neither is a privacy design. `oidc` mode establishes *who is
calling*; the roster scoping establishes *what they may see*; what a teacher's assistant should be
allowed to do with a class's outcomes is a policy question for whoever owns learner data at your
institution. Answer it before you point this at real classes, not after.

## Deploying it

Same procedure as the other services: build `Dockerfile.mcp-connector`, configure `AUTH_MODE=oidc`
with the issuer, audience and public URL above, and give it the Runtime API's internal service
credential. It refuses to start in production in any other shape.

Register it in your provider as its own API, whose identifier is the connector's own `/mcp` URL. That
identifier is what `OIDC_AUDIENCE` checks, and it is the check that stops a token minted for a
different service in the same tenant from opening this one.
