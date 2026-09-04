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

Plus one managed Postgres instance, which is the system of record for all of them, and one optional
service — the document converter (`Dockerfile.document-converter`) — needed only where PowerPoint or
Word files are turned into learning objects; see step 6b.

The Evidence API runs inside the Runtime API's process rather than as a seventh service. It verifies
launch descriptors with the Runtime's signing key and writes to the same store, so splitting them
would buy independent scaling at the cost of a second copy of the key ring. Both are versioned
surfaces under `/api/v1` and can be separated later without a contract change.

### The folded topology

Four of those six units can run in one process instead. Two flags on the Runtime API decide, and both
default to false, so a deployment that sets neither gets exactly the six-unit shape above:

| Flag | Effect |
| --- | --- |
| `SERVE_WEB_APPS=true` | Serves the learner portal, administration workspace and operations console at `/portal/`, `/admin/` and `/console/` |
| `SERVE_MCP_CONNECTOR=true` | Mounts the agent connector's `/mcp` endpoint and its RFC 9728 metadata on this listener |

Nothing about those surfaces changes when they are folded in. The same built bundles are served, and
the connector still verifies the agent's own token and still reaches the Runtime API over HTTP
carrying its separate internal service credential. That is what makes the two shapes comparable:
the same image, the same code paths, the same credentials, one restart apart.

`Dockerfile` carries the three application bundles whether or not they are served, so switching
topology never needs a rebuild. Where they come from, in order: `WEB_APPS_ROOT` if you set it, which
is then the only place looked at; otherwise `web/<slug>`, which is the container layout; otherwise
`packages/<package>/dist`, which is a workspace checkout after `pnpm build`. A flag set with no
bundle to serve refuses to start rather than serving a 404 where a workspace should be.

**The Player Shell is not on that list and cannot be.** It serves `Access-Control-Allow-Origin: *`,
which is load-bearing rather than lazy: a module runs in an iframe sandboxed without
`allow-same-origin`, so it fetches its own bundle from an opaque origin and the wildcard is what
lets the bundle load at all. Serving it from the API's origin would put wildcard CORS on an
authenticated API, and the control that forbids that reads the Fastify source rather than an nginx
configuration, so it would not catch it. Keep it on its own origin in every topology.

Front-end configuration follows the topology. Built for its own origin, an application reads the
values compiled into it at build time. Served by the API process, the same `VITE_*` names are read
from that process's environment and written into the page ahead of the bundle, so one image can be
promoted between environments without a rebuild. Only names carrying the `VITE_` prefix are
forwarded, which is the rule Vite already uses to decide what may reach a browser. The API bases
default to the serving origin, and each application's OIDC redirect URI is derived from where it is
mounted — so register `https://<host>/portal/`, `https://<host>/admin/` and `https://<host>/console/`
with your identity provider, rather than one shared value.

Register those same three URLs as **allowed logout URLs** too. Signing out, and restarting sign-in
after a session expires, navigate back to where the application is actually served rather than to the
origin, which under a prefix is the API's own index. The applications derive that from the document
they are served as, so nothing extra needs configuring on this side; the provider still has to accept
the URL it is asked to return to.

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

### 6a. Deploy the learning record store

`LRS_ENDPOINT` may point at a commercial learning record store or at the one this platform ships
(`packages/lrs`, `Dockerfile.lrs`, `railway.lrs.json`). Deploy it before the Runtime API: the Runtime
refuses to start without a reachable endpoint configured, and the forwarder will queue rather than
lose anything if the store is briefly unavailable afterwards.

```
LRS_DATABASE_URL=…                        # its own database, not the platform's; required in production
LRS_ACCEPTED_BEARER_TOKENS=…              # or LRS_ACCEPTED_BASIC_CREDENTIALS; at least one required
```

Give it a database of its own rather than pointing it at the platform's. Evidence outlives most of
what surrounds it: a catalogue can be rebuilt and the runtime restored from this morning's backup,
and the record of what a learner did has to survive both untouched. Sharing one database makes those
two operations the same operation.

Then point the Runtime API at it — `LRS_ENDPOINT` is the origin, and the service appends
`/statements` itself — with `LRS_BEARER_TOKEN` set to one of the tokens the store accepts. Confirm
the two agree before trusting it:

```sh
curl -s https://lrs.example/about                       # {"version":["1.0.3"]}
curl -s -o /dev/null -w '%{http_code}\n' \
  -X PUT "https://lrs.example/statements?statementId=$(uuidgen)" \
  -H "authorization: Bearer $LRS_BEARER_TOKEN" \
  -H 'content-type: application/json' -H 'x-experience-api-version: 1.0.3' \
  -d '{"actor":{"objectType":"Agent","account":{"homePage":"https://lorb.example/pseudonym","name":"'"$(printf '0%.0s' {1..64})"'"}},
       "verb":{"id":"http://adlnet.gov/expapi/verbs/completed"},
       "object":{"id":"https://lorb.example/activities/smoke","objectType":"Activity"}}'
# 204 stored · 204 again on a repeat · 409 if a different statement holds that id · 401 if the token is wrong
```

Both credential settings are lists. To rotate the forwarder's token, add the new one to
`LRS_ACCEPTED_BEARER_TOKENS` alongside the old, change `LRS_BEARER_TOKEN` on the Runtime API, then
drop the old one — in that order, so no delivery falls between the two changes.

The store refuses a statement whose actor carries an `mbox`, `openid`, `mbox_sha1sum` or display
name. If a deployment genuinely receives identified statements from elsewhere, that is a deliberate
`LRS_REQUIRE_PSEUDONYMOUS_ACTOR=false`, not a default to drift into.

### 6b. Deploy the document converter (optional)

Only needed to turn an uploaded PowerPoint or Word file into a `document-player` learning object —
skip this if that path isn't in use yet. Unlike every other service here it needs real system
packages, not just Node (`packages/document-converter/README.md` has the full pipeline):

```
DOCUMENT_CONVERTER_PUBLIC_URL=…    # this service's own public origin; defaults to localhost, wrong in production
DOCUMENT_CONVERTER_DATA_DIR=…      # defaults to /app/data — attach a volume, or every restart loses every conversion's output
```

Deploy it as **exactly one replica**. Its output is deliberately temporary storage (its own local
disk), never a durability guarantee: a caller registering a document manually should fetch the page
image URLs once, right after conversion, and re-host them before calling
`POST /api/v1/internal/runtime/documents`; the Admin UI's own upload button (below) does not
re-host, so a second replica's separate disk would serve 404s for pages the first one converted.

For the Administration workspace's own upload button (`.../learning-objects/documents/upload`) to
work, also point the **Runtime API** at this service — a separate setting from the two above, which
are the converter's own:

```
DOCUMENT_CONVERTER_URL=…    # the Runtime API's setting: this service's base origin, https in production
```

Without it, the workspace's document tab refuses cleanly (`DOCUMENT_CONVERTER_NOT_CONFIGURED`)
rather than the whole publisher surface failing to start.

### 7. Register content

A new catalogue is empty. The Administration workspace does this on the Learning objects page — "New
learning object" either authors a quiz or registers a packaged module. The same thing through the
Publisher API directly, as an administrator:

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

The rest of the surface, all of it requiring an administrator token, an `idempotency-key` and
membership of the object's repository:

| Request | What it does |
| --- | --- |
| `GET …/learning-objects?repository_id=&status=` | The catalogue, filtered |
| `GET …/learning-objects/{id}` | One object with its version chain |
| `POST …/learning-objects/quizzes` | Authors a quiz — questions as data on the shared quiz player, never a bundle |
| `PATCH …/learning-objects/{id}` | Edits title, description, duration, kind. Nothing a launch resolves to |
| `GET …/learning-objects/{id}/content` | The authored questions, marking key included. Audited, never cached |
| `PUT …/learning-objects/{id}/content` | Publishes new questions as a new content version; the superseded one stays readable |
| `POST …/learning-objects/{id}/suspend` \| `/restore` | Takes an object out of the catalogue, and puts it back |
| `POST …/learning-objects/{id}/retire` | Ends it. Does not reverse |
| `DELETE …/learning-objects/{id}` | Removes it — only once suspended or retired, and refused for any object ever launched or assigned |

Suspension, retirement and deletion also revoke the object's smart link: a withdrawn object must not
stay reachable through a link that needs no sign-in.

Video, document (PowerPoint/Word-as-slides), audio and ebook content register the same way quizzes
do: structured JSON against a fixed shared player, never a bundle. Two surfaces reach the same
`registerMedia` call: the Administration workspace's "New learning object" dialog (video, document,
audio and ebook tabs alongside quiz and packaged module — an administrator, repository membership,
the same trust model as authoring a quiz there), and the internal service surface
(`POST …/internal/runtime/videos` \| `/documents` \| `/audio` \| `/ebooks`, the pre-shared service
credential from step 5, not an admin token) the agent connector uses. The workspace's document tab
uploads a file and converts it through step 6b's document-converter service in one action; the
internal surface expects `pages` (image URLs) already assembled, since an agent has usually produced
or fetched those itself.

**Ebooks** (migration 016) are EPUB 3 files opened in the shared reader at
`/modules/ebook-player/` on the Player Shell origin. The reader unpacks the archive in the browser and
renders each content document with scripts and every other active element stripped, so a book — and
its EDUPUB semantics (learning objectives, assessments, keywords) — is data it displays, never code the
sandbox runs. `epub_url` is either an https URL the learner's browser can fetch with CORS, or a
`/modules/…` path served by the Player Shell itself. A three-page exemplar,
*Photosynthesis: how plants make food*, ships with the reader at
`/modules/ebook-player/exemplar/photosynthesis-reader.epub` and is published into the default
repository wherever `SEED_EXAMPLE_CONTENT` is on; a production deployment (where that flag is refused)
registers it through the ebook tab with that same path.

**Marketplace listing** (migration 012) lets a repository opt an already-published object in to
cross-repository discovery — `PUT …/learning-objects/{id}/marketplace-listing` with `{"listed":
true}`, repository_operator membership, same idempotency and audit shape as every other publisher
edit. Nothing about the object changes: not its version chain, not its content, not which repository
owns it — only whether it appears on `GET /api/v1/admin/marketplace` for administrators outside that
repository to find.

The same call optionally carries what subscribing costs (migration 013): `price_cents`, `currency`
(3-letter ISO), and `billing_period` (`one_time` | `month` | `year`). This is **informational only —
LORB never processes payment or gates access on it**; it exists so a subscribing administrator is
shown a real figure the listing repository entered, not a placeholder. Every call is authoritative
for price, not a partial patch: omitting the three fields (or setting `price_cents` to `0`/`null`)
lists the object as free, even if a price was set on an earlier call. A non-zero `price_cents`
requires both `currency` and `billing_period`, so a subscriber is never shown a bare number with
nothing to say what it's a number of.

An administrator "subscribes" to a listed object from their own teaching workspace, shown that price
and term first, which bookmarks it into their assignable set —
`POST /api/v1/admin/marketplace/imports {"object_id": "…"}` — recording the bookmark in
`marketplace_import`, keyed to the caller's own pseudonym. This copies nothing: `class_assignment`
(step above, `POST …/classes/{classId}/assignments`) already resolves any published `object_id`
regardless of which repository it belongs to, so the bookmark exists purely so
`GET /api/v1/admin/marketplace/imports` can tell the teacher-facing UI which objects outside the
caller's own repositories should show up as assignable. `DELETE …/marketplace/imports/{objectId}`
unsubscribes — it removes the bookmark without touching the object or anything already assigned from it.

`GET /api/v1/admin/learning-objects/{id}/preview` backs the teacher workspace's preview modal — any
admin, no repository membership required, same scope as the unfiltered object list above. It mints
no descriptor and creates no attempt, so opening one leaves no evidence. The seven data-authored
kinds (quiz, video, document, audio, ebook, lti-tool, external-embed) return structured content; a code-bundled object comes
back `"kind": "unsupported"` rather than something rendering its live module here would have to fake. An
ebook preview returns `epub_url` and the display metadata, not the book itself. A
quiz's `correct_option_id` and `explanation` are never included — the same marking-key withholding
the learner-facing content route already applies.

**LTI 1.3 tools** (migration 014) register a third party's own tool as a learning object —
`POST …/learning-objects/lti-tools` with `{"title", "tool_name", "oidc_login_url",
"target_link_uri", ["description"]}`, both URLs required to be `https://`. This is the one learning
object kind that ever points at a URL outside the Player Shell's own origin: every other kind's
`module_path` stays a relative path under that origin (the invariant `routes/publisher/objects.ts`
documents at the top), and an lti-tool is launched by a real LTI 1.3 OIDC/id_token handshake instead
of an iframe embed of an arbitrary origin nobody reviewed. Scope is Resource Link launch only — no
Assignment & Grades Services (no grade passback), no Deep Linking. Registration is per-object: there
is no separate platform/tool registry screen, and each registration mints its own `client_id` and
`deployment_id` server-side, returned once in the response for handing to the tool provider.

The handshake needs its own signing key ring, distinct from the descriptor ring because it signs
material a third party verifies — configure `LTI_PRIVATE_KEY_PATH` (or `LTI_PRIVATE_KEY_PEM`) and
`LTI_KID` the same way as the descriptor key in step 2, or `LTI_SIGNING_KEYS` for a rotation.
Optional even in production: a deployment with no LTI tools registered needs no LTI key configured,
and an ephemeral one is generated at start-up in its absence, same as the descriptor ring outside
production.

Two routes exist purely for the tool's own side of the handshake, unauthenticated by design — the
credential is the launch-scoped `login_hint`, not a caller token:

| Request | What it does |
| --- | --- |
| `GET /api/v1/lti/jwks` | The LTI ring's public keys, for the tool to verify the id_token below |
| `GET /api/v1/lti/authorize` | The OIDC authorization endpoint the tool redirects to after its own `oidc_login_url`; returns an auto-submitting HTML form posting a signed `LtiResourceLinkRequest` id_token to the tool's `redirect_uri`, refused unless it is byte-for-byte the registered `target_link_uri` |

Player Shell recognises an lti-tool launch from the `content_profile` claim on its own launch
descriptor and never creates the sandboxed module iframe every other kind uses — it renders a launch
panel instead, and on click navigates its own document through the tool's OIDC flow. The learner
portal's iframe sandbox is widened only for `kind === "lti-tool"`, to `allow-scripts allow-forms
allow-same-origin` — every other kind keeps the plain `allow-scripts` sandbox unchanged.

**External embeds** (migration 015) register a plain iframe embed of a third party's page —
`POST …/learning-objects/external-embeds` with `{"title", "embed_url", ["description"]}`,
`embed_url` required to be `https://`. Like an lti-tool, this is the one other learning-object kind
that points at a URL outside the Player Shell's own origin — the `native-web-package` `module_path`
invariant is still never touched. Unlike an lti-tool launch, there is no signed handshake and no
verification of the embedded page's identity at all: the only guardrail is that `embed_url`'s origin
must already be on `ALLOWED_EXTERNAL_EMBED_ORIGINS`, configured at the deployment level (not
admin-editable — changing the list is a redeploy). Registration refuses every `embed_url` outright
when that list is empty, which is the default, so a deployment that hasn't opted in to external
embeds can't accidentally accept one. Prefer registering a tool as `lti-tool` instead whenever the
third party can do LTI — it is the stronger guarantee.

Player Shell recognises `content_profile: "external-embed-v1"` the same way it recognises an
lti-tool launch, but stays in the ordinary module-iframe layout rather than replacing itself: it
widens that iframe's sandbox to `allow-scripts allow-forms allow-same-origin`, sets its `src`
directly to `embed_url` (no module handshake — the embedded page is somebody else's and won't send
one), and shows a "Mark as complete" button in its header, since nothing about a plain embed can
signal completion on the learner's behalf. The learner portal's own iframe sandbox is widened the
same way for `kind === "external-embed"`, alongside `lti-tool`.

## Deploying a new version

1. Apply migrations first: `pnpm db:setup:production`. Migrations here are additive — new tables and
   nullable columns — so the previous version keeps running against the new schema while replicas
   roll.
2. Roll the Runtime API replicas. Attempt state is in Postgres, so a replica leaving mid-request
   costs that request and nothing else. Shutdown is graceful: in-flight requests finish before the
   process exits.

   While replicas are mixed, do not *exercise* a capability the deploy introduces — mint nothing,
   share nothing that only the new version understands. A concrete case: a version-pinned smart
   link created while an old replica still serves redemptions is redeemed by that replica as the
   object's *active* version, because the old code does not read the pin. The window is the roll
   itself; a pinned link minted after `/ready` is green on every replica behaves as pinned
   everywhere.
3. Roll the front ends. They are static bundles behind a CDN or nginx; nothing coordinates with the
   API roll.

Watch `/ready` through the roll, and `lorb_evidence_forwarded_total{outcome="delivered"}` after it —
the forwarder is the part most likely to be affected by a network or credential change.

## Rolling back

Redeploy the previous image. Do **not** roll migrations back: the schema is additive, so the previous
version runs against the newer schema unchanged, and a down-migration would drop columns the newer
version's rows still use. If a migration itself is the problem, write a new forward migration.
