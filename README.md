# LORB — Learning Object Repository and Broker

LORB registers, resolves, launches, presents and instruments reusable learning objects. A consumer
application asks it for a launch; it answers with a short-lived signed descriptor that names exactly
one immutable version of one piece of content, hosts that content in a sandboxed player, holds the
attempt's state and lifecycle, and delivers the resulting xAPI evidence to a learning record store.

It is not an LMS, it does not author content, it does not issue identities, and it does not decide
entitlement. It brokers the launch and it owns the evidence trail.

## What it does

**Launch.** `POST /api/v1/runtime/launches` authenticates the learner against your identity provider,
resolves the object to its published version, applies the launch policy that governs the repository,
and returns a JWS descriptor valid for minutes. The descriptor names the object version and package
version explicitly — never "latest" — so evidence recorded against it says what was actually
delivered.

**Present.** The Player Shell embeds the content in an iframe sandboxed without `allow-same-origin`.
The module's origin is therefore opaque, so the two of them establish a `MessageChannel` through a
nonce-authenticated handshake and everything afterwards travels on that port. No wildcard origin
exists in either direction.

**Instrument.** The player emits xAPI statements. The Evidence API binds each one to the pseudonym
the descriptor names and the attempt it was launched for, writes it to a durable outbox, and answers.
A worker delivers from that outbox to the learning record store with retry, backoff and
dead-lettering — acceptance and delivery are separated so a learner's work never depends on the
learning record store being reachable at that moment.

**Retain.** The learning record store is the durable end of that trail, and the platform ships one
(`packages/lrs`) rather than assuming you have bought one. It speaks the xAPI statements resource, so
`LRS_ENDPOINT` can point at it or at a commercial store without either side knowing the difference.
A statement is immutable once accepted — enforced by a database trigger — a redelivery is a no-op,
and an actor that identifies a person is refused, because the evidence chain is pseudonymous by
construction and a record store is where that would leak.

**Administer.** Repositories, memberships, players, launch policies, class rosters and an append-only
audit trail, with separation of duties on the actions that warrant it: the database itself refuses a
self-approval.

**Publish.** Learning objects are registered, authored, edited, versioned and withdrawn through the
Publisher API, and through the Administration workspace that sits on it. The line it draws is between
what the catalogue *says* and what is *delivered*: a title, description, stated duration and kind are
edited in place, while anything a launch resolves to is versioned. Publishing a new version — a
package or a quiz's questions — inserts a new immutable version and supersedes the previous one;
nothing is modified in place, so an attempt still describes what was actually delivered. Withdrawal
goes suspend (reversible), retire (not), delete — and deletion is offered only once an object has
been withdrawn, then refused outright for anything ever launched or assigned: evidence outlives the
catalogue.

## Identity and pseudonymity

Learners sign in through your identity provider. LORB never sees a password and issues no identity of
its own.

What it stores is a pseudonym: `HMAC-SHA-256(tenant secret, issuer | subject | purpose)`. That
pseudonym is the actor on every attempt and every xAPI statement. The mapping back to a learner is
never stored — a class result is produced by recomputing the pseudonym from the roster at read time,
and the pairing exists only for the duration of that request. There is no standing re-identification
table, by construction rather than by policy.

The consequence is worth stating plainly: the tenant secret is the identity function for the whole
evidence record, and changing it is a data-protection event rather than a variable update. See
[docs/runbooks/key-rotation.md](docs/runbooks/key-rotation.md).

## Architecture

```
identity provider ──▶ learner portal ──▶ Runtime API ──▶ launch descriptor (JWS, ES256, minutes)
                                              │                    │
                                              ▼                    ▼
                                          Postgres          Player Shell ──▶ sandboxed module
                                              ▲                    │
                                              │              evidence.emit
                                              │                    ▼
                              evidence forwarder ◀── outbox ◀── Evidence API
                                              │
                                              ▼
                                    learning record store  (packages/lrs, or your own)
```

| Service | Package | Notes |
| --- | --- | --- |
| Runtime API | `packages/runtime-api` | Launch, attempts, catalogue, administration, publisher, internal surface |
| Evidence API | `packages/evidence-api` | Mounted on the Runtime listener; shares its store and key ring |
| Evidence forwarder | `packages/evidence-forwarder` | Claims outbox rows with `for update skip locked`, so every replica can run one |
| Player Shell | `packages/player-shell` | Verifies the descriptor, sandboxes the module, brokers the channel |
| Learner portal | `packages/learner-portal` | Catalogue, launch, and the teacher-facing roster area |
| Administration workspace | `packages/admin-ui` | Repositories, players, policies, approvals, audit |
| Operations console | `packages/ops-console` | Read-only operational projections and a test launcher |
| Learning record store | `packages/lrs` | The durable end of the evidence trail: xAPI statements, stored immutably |
| Agent connector | `packages/mcp-connector` | A remote MCP server for a teacher's assistant |
| Web sign-in | `packages/web-auth` | Authorization code with PKCE, shared by the three front ends |

Postgres is the system of record for all of it. A replica holds nothing that matters, so it can be
replaced at any moment — and a production process refuses to start without a database precisely so
that stays true.

## Running it locally

Node 20 and pnpm 9.

```sh
cp .env.example .env
# fill in the three secrets .env asks for
sed -i "s|<hex-encoded-32-byte-secret>|$(openssl rand -hex 32)|" .env
sed -i "s|<hex-encoded-32-byte-service-token>|$(openssl rand -hex 32)|" .env
sed -i "s|<hex-encoded-32-byte-agent-bearer-token>|$(openssl rand -hex 32)|" .env

pnpm install
docker compose up -d postgres
pnpm db:setup            # SEED_EXAMPLE_CONTENT=true in .env publishes the bundled examples
pnpm dev
```

`pnpm dev` runs the same host as production, with the development conveniences configuration allows
outside it: an ephemeral signing key when none is configured, the in-process store when no database
is reachable, the bundled example catalogue, and the development identity provider. Every one of
those is refused when `NODE_ENV` is `production` or `staging`, so there is one code path, not two.

`docker compose up -d` brings up the whole stack instead — Postgres, the Runtime and Evidence APIs,
the Player Shell, a development identity provider, a development learning record store, and the agent
connector.

## Deploying it

[docs/runbooks/deployment.md](docs/runbooks/deployment.md) has the full procedure. The short version:

1. Provision Postgres, run `pnpm db:setup`.
2. `pnpm keys:generate`, and give every Runtime API replica the same key.
3. Register the platform with your identity provider — one API for the Runtime, one public client per
   front end.
4. Configure and start. A production process names every missing setting at once and exits 78 rather
   than starting in a shape nobody would accept.
5. Build the front ends. Each image refuses to build for a deployed environment with no identity
   provider configured, which is what stops one falling back to the local sign-in.
6. Register content — through the Administration workspace, or the Publisher API directly. A new
   catalogue is empty. See [Publishing a packaged module](#publishing-a-packaged-module).

The included `railway.*.json` files describe one deployment on Railway; nothing in the images is
specific to it.

## Publishing a packaged module

How a web tool you have built becomes a learning object an administrator can govern and a learner can
launch. A packaged module is a `native-web-package`: code, as opposed to the data-authored kinds
(quiz, video, document, audio, ebook, LTI tool, external embed) which are authored through their own
routes and need none of this.

### Step 1 — make the bundle reachable under the Player Shell origin

This is the step people expect to be able to skip, and cannot. A learning object names its code with
`module_path`, and at launch the Runtime API resolves it as `PLAYER_SHELL_ORIGIN + module_path` —
nothing else. Registration enforces that: `module_path` must begin with `/`, must not be
protocol-relative, must not contain `..`, and cannot be an absolute URL. A publisher who could name
an arbitrary origin could point a learner's browser at code nobody reviewed, so the origin is the
platform's decision and not the publisher's.

A tool deployed elsewhere is therefore not reachable by registering a path to it. One of three things
has to happen first.

**Ship it into the Player Shell image.** Two lines in `Dockerfile.player-shell` — build the package,
copy its `dist` to `/usr/share/nginx/html/modules/<slug>` — and after the next Player Shell deploy
`/modules/<slug>/index.html` is a valid `module_path`. This is how every bundled player gets there.
Use it when the tool lives in this repo and versions with the platform.

**Mount an existing deployment under that origin.** Proxy `/modules/<slug>/` from the Player Shell to
wherever the tool already runs. The URL contract holds and the bundle never moves. Use it when the
tool has its own team or release cadence. Note that the Player Shell serves
`Access-Control-Allow-Origin: *`, because modules are sandboxed without `allow-same-origin` and fetch
their own bundles from an opaque origin — whatever is proxied has to be safe under that header and
must not rely on cookies or credentialed requests.

**Register it as a player version and route to it.** The only sanctioned route for an absolute URL to
another origin, and deliberately the heaviest: `POST /api/v1/admin/players`, then
`POST /api/v1/admin/players/:id/versions` with an SRI hash whose `module_origin` is on the allow-list
and matches `module_url`, then promote `TESTING → APPROVED → ACTIVE`, then a launch policy rule that
routes matching launches to that version. Use it when a third party hosts the player, or when you
need to change which player renders a whole class of content without touching any catalogue entry.
An object whose package version is marked `shared_player` keeps its own `module_path` regardless, so
pinned content is never repointed underneath its publisher.

### Step 2 — have somewhere to publish into

The target repository must exist and be `ACTIVE`, and the publisher must hold `repository_operator`
membership of it. Neither is a formality: registration is refused with `REPOSITORY_NOT_FOUND` or
`REPOSITORY_STATE_INVALID`, or as unauthorised, and the refusal is audited.

### Step 3 — describe the object

Through the Administration workspace, or `POST /api/v1/publisher/learning-objects` directly:

```sh
curl -X POST "$RUNTIME/api/v1/publisher/learning-objects" \
  -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{
    "repository_id": "…",
    "title": "Photosynthesis Explorer",
    "description": "An interactive model of the light-dependent reactions.",
    "duration": "20 minutes",
    "module_path": "/modules/photosynthesis-explorer/index.html",
    "semver": "1.0.0",
    "sha256": "…"
  }'
```

The idempotency key is mandatory, and a retry replays the original response rather than publishing a
second object. The object is created `PUBLISHED` with an active object version and an active package
version in one call — there is no separate publish action for a packaged module.

### Step 4 — what the administrator can now do

The object appears on the publisher listing, carries an audit record for `learning_object.register`,
and can be suspended, restored, retired or listed on the marketplace. Title, description, duration
and kind are editable in place. `module_path`, `sha256` and `repository_id` are not: a repointed
object is a new version, and a moved one is a launch policy's problem.

Shipping a fix is `POST /api/v1/publisher/learning-objects/:id/versions` with a new `semver` and
digest. The object keeps its identity, so assignments and smart links still resolve, and the previous
package version is left intact — attempts already recorded against it still name content that exists.

### Step 5 — what the learner gets

The object appears in `GET /api/v1/runtime/learning-objects?repository_id=…` for a signed-in learner
with access to that repository. Launching it posts to `/api/v1/runtime/launches` with
`requested_launch_mode: "embedded-iframe"`, which creates an attempt pinned to the object version and
package version active at that moment and returns a short-lived signed descriptor and a Player Shell
URL. The Shell loads `PLAYER_SHELL_ORIGIN + module_path` into a sandboxed iframe and hands the module
the descriptor over a nonce-brokered channel; evidence flows back naming that exact package version,
and the learner reaches the module only as a pseudonym.

A launch for an unknown, unpublished, retired or cross-repository object is refused rather than
resolved to a default package.

## Operations

| | |
| --- | --- |
| Liveness | `GET /health` — dependency-free on purpose |
| Readiness | `GET /ready` — database, persistence mode, signing key |
| Metrics | `GET /metrics` — Prometheus, `lorb_` prefix |
| Logs | JSON, redacted at the serialiser, correlated by `X-Correlation-ID` |

Runbooks for [deployment](docs/runbooks/deployment.md),
[key rotation](docs/runbooks/key-rotation.md),
[backup and restore](docs/runbooks/backup-and-restore.md),
[incident response](docs/runbooks/incident-response.md) and
[observability](docs/runbooks/observability.md).

## Smart links

A published learning object can have a durable, revocable smart link: a URL that opens straight into
the Player Shell with no consumer application and no sign-in. Redemption mints a fresh attempt and
descriptor and redirects, so the Player Shell is unchanged and no CORS is involved.

The learner is a pseudonym derived from a random identifier in a long-lived cookie, namespaced by a
fixed `smart-link` issuer so it can never collide with a pseudonym from a genuine sign-in. The token
is stored only as a hash and returned once, at creation.

The trade-off is the point of the feature and should be named rather than discovered: anyone holding
the link can launch that object, indefinitely, anonymously. It suits an open resource. It does not
suit graded work, which is why class assignment goes through the authenticated path instead and never
returns a descriptor to the assigning caller.

## Agent connector

`packages/mcp-connector` is a remote MCP server that lets a teacher's assistant draft a quiz, register
it as a learning object, assign it to a class, and read back aggregated results — through the real
runtime and evidence pipeline, not a mock of it.

Two properties keep it safe to run:

**A quiz is data, not code.** `create_quiz` writes a structured JSON payload rendered by one fixed,
already-reviewed player package. An agent never registers a bundle, so there is no per-quiz
code-injection surface. The answer key is served only on the learner-facing content route and is
returned by no tool or resource.

**Two trust domains that never share a credential.** The agent session authenticates against your
identity provider (`AUTH_MODE=oidc`, the default and the only mode a deployment may use); the
connector reaches the Runtime API's internal surface with a separate service credential. They share
no token, no scope and no signing key, and the Runtime API refuses to start if they are configured to
the same value.

Access is scoped by an explicit link a teacher creates between their account and their assistant's
principal. It is never inferred from a matching email or a shared claim — a principal with no link
sees nothing, rather than seeing everyone's classes.

See [packages/mcp-connector/README.md](packages/mcp-connector/README.md).

## Enforced controls

An automated suite guards the properties that must not regress, and each has a test that fails if the
control is removed:

- Descriptors carry no learner name, email, date of birth or free text, and no floating version
  reference.
- Launches require an idempotency key, replay identically, and refuse a key reused for a different
  request.
- A launch for an unknown, unpublished or cross-repository object is refused — never silently
  resolved to a default package.
- Access tokens are audience-bound; descriptors are verified by `kid` against the published JWKS.
- Evidence is bound to the descriptor's actor and attempt, deduplicated by statement UUID, immutable
  once accepted, and undeletable.
- Attempt state uses optimistic concurrency; illegal lifecycle transitions are refused; terminal
  states are terminal.
- No wildcard `postMessage` origin, no wildcard CORS, no unlisted origin, no built-in origin nobody
  reviewed.
- The module iframe runs without `allow-same-origin`.
- Credentials and learner-entered content are redacted from logs at the serialiser.
- A production process refuses in-memory persistence, an ephemeral signing key, the development
  identity provider, example content in the catalogue, and an empty origin allow-list.

`pnpm test` runs all of them, against a real Postgres where the property needs one.
`pnpm test:browser` drives a genuine launch in Chromium, which is the one hop the other suites cannot
reach.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). The specification record is in [docs/specs](docs/specs).

Changes to the launch descriptor schema, the pseudonymisation function, the error taxonomy, or any of
the enforced controls above are contract changes: they need a review that considers every consumer,
not only the caller that prompted them.
