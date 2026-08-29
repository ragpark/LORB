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

Its output is deliberately temporary storage (its own local disk), never a durability guarantee —
a caller registering a document should fetch the page image URLs once, right after conversion, and
re-host them before calling `POST /api/v1/internal/runtime/documents`.

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

Video, document (PowerPoint/Word-as-slides) and audio content register the same way quizzes do:
structured JSON against a fixed shared player, never a bundle — but through the internal service
surface (`POST …/internal/runtime/videos` \| `/documents` \| `/audio`, the pre-shared service
credential from step 5, not an admin token), the same one the agent connector uses for quizzes. There
is no Administration workspace screen for these three yet.

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
