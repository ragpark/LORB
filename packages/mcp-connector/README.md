# mcp-connector

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.** This is a proof of concept at
> the same maturity level as the rest of this repository. It makes no compliance claim, resolves no
> open blocker, and must not be deployed to a shared or production environment.

A remote MCP server (streamable HTTP transport) that lets a teacher's AI agent draft a quiz, register
it as a LORB learning object, assign it to a class, and read back aggregated results — through LORB's
real Runtime and Evidence pipeline, not a mock of it.

## Two trust domains, kept apart

| | Agent-facing (this package) | Learner-facing (existing) |
|---|---|---|
| Principal | The teacher's agent session | One learner, one launch |
| Credential | Pre-shared bearer token, `AUTH_MODE=poc` | Synthetic IES ES256 token, `aud: lorb-runtime` |
| Lifetime | Per environment, static | Ten minutes |
| Issued by | Environment configuration | `packages/stub-ies` |

They share no token, no scope, and no signing key. The agent's bearer token never reaches a launch
descriptor or an IES token, and an IES token is never accepted here. `loadConfig` refuses to start if
the agent token and the Runtime internal-service credential are configured to the same value.

### Two authentication modes

| | `AUTH_MODE=poc` | `AUTH_MODE=oidc` |
|---|---|---|
| Credential | One pre-shared bearer token per environment | A token issued by an identity provider you already run |
| Validated by | Constant-time comparison | Signature against the provider's JWKS, plus `iss`, `aud` and expiry |
| Discovery | None | RFC 9728 metadata at `/.well-known/oauth-protected-resource` |
| Suitable for | Local development and CI | Anything a real person uses |

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

Two further guards, both fail-closed at startup: the issuer must be `https`, and
`MCP_POC_BEARER_TOKEN` must be **absent** in `oidc` mode, so a pre-shared token cannot linger as a
second, weaker way past the provider.

### What `oidc` mode does and does not buy you

It makes the connector a valid OAuth resource server, which is the half of the problem that belongs
in this repository. Whether a given client can then complete a flow depends on the provider: Claude
needs dynamic client registration, client ID metadata documents, or a client you pre-register and
paste in. That is a decision about your identity provider, not about this code.

This does **not** close BLK-08. It is a necessary step in the direction BLK-08 has to go — the
synthetic IES can never be the answer for a real person — but the privacy and security design work
those blockers name is still outstanding.

## Resources

| URI | Returns |
|---|---|
| `class://{classId}` | Name, year group, subject, learner count. No learner names or identifiers. |
| `class://{classId}/recent-topics` | Recently taught topics, so generated questions are relevant. |
| `quiz://{objectId}/results` | Assigned/completed counts, mean `result.score.scaled`, not-yet-started pseudonyms — read from the Evidence API, not canned. |

Class data comes from `packages/stub-roster`, a non-production stub: LORB-001 has no class or roster
concept of its own.

## Tools

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
for a graded class assignment, and the repository's own README already flags smart links as a material
change to the launch surface. `assign_quiz` goes through the authenticated internal launch path
instead, and never returns a launch descriptor or player URL to the agent.

## Three idempotency layers

Each guards a different hop and none replaces another:

1. **This connector** (`idempotency.ts`) — a repeated `assign_quiz` call from the agent or its host.
2. **Runtime API** — the `Idempotency-Key` required on every launch and internal batch request.
3. **Evidence API** — statement UUID deduplication in the outbox.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `AUTH_MODE` | no (`poc`) | `poc` or `oidc`; any other value refuses to start. |
| `MCP_POC_BEARER_TOKEN` | in `poc` | ≥32 characters. Must be absent when `AUTH_MODE=oidc`. |
| `OIDC_ISSUER` | in `oidc` | Expected `iss`. Must be `https`. |
| `OIDC_AUDIENCE` | in `oidc` | Expected `aud` — this resource's own identifier. |
| `MCP_PUBLIC_URL` | in `oidc` | Public base URL, for the RFC 9728 `resource` value. |
| `OIDC_JWKS_URL` | no | Defaults to `${OIDC_ISSUER}/.well-known/jwks.json`. |
| `OIDC_REQUIRED_SCOPE` | no | When set, a valid token without it gets `403 insufficient_scope`. |
| `RUNTIME_INTERNAL_SERVICE_TOKEN` | yes | ≥32 characters, must differ from the above. |
| `RUNTIME_API_BASE` | no | Default `http://localhost:3000`. |
| `EVIDENCE_API_BASE` | no | Defaults to `RUNTIME_API_BASE` — the MVP evidence store is process-local to the Runtime API. |
| `ROSTER_API_BASE` | no | Default `http://localhost:4100`. |
| `PORT` / `MCP_CONNECTOR_PORT` | no | Default `4200`. |

## Endpoints

- `POST|GET|DELETE /mcp` — streamable HTTP transport, stateless (one server and transport per request).
- `GET /` — unauthenticated endpoint index.
- `GET /health` — unauthenticated liveness only.
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata, **`oidc` mode only**. In `poc`
  mode it is deliberately not served: publishing a document pointing at an authorization server that
  does not exist would start a flow no client could finish.

## Trying it with Claude

> Everything below runs against a **local, uncertified PoC** holding synthetic data only. Do not
> expose it on a public URL — see the warning at the end of this section.

### 1. Generate the three secrets

Compose refuses to start without them. Export them as well as writing them to `.env` — later steps
read `$MCP_POC_BEARER_TOKEN` from your shell, and `.env` alone does not put it there:

```sh
export PSEUDONYM_TENANT_SECRET=$(openssl rand -hex 32)
export RUNTIME_INTERNAL_SERVICE_TOKEN=$(openssl rand -hex 32)
export MCP_POC_BEARER_TOKEN=$(openssl rand -hex 32)
{ echo "PSEUDONYM_TENANT_SECRET=$PSEUDONYM_TENANT_SECRET"
  echo "RUNTIME_INTERNAL_SERVICE_TOKEN=$RUNTIME_INTERNAL_SERVICE_TOKEN"
  echo "MCP_POC_BEARER_TOKEN=$MCP_POC_BEARER_TOKEN"; } >> .env
```

In a **new** shell later on, load them back with `set -a; . ./.env; set +a` rather than regenerating
them — new tokens would not match the running containers.

### 2. Start the stack

```sh
docker compose up -d
```

That brings up the Runtime API (`:3000`, with the Evidence routes mounted on it), the synthetic IES
(`:4000`), the roster stub (`:4100`), the Player Shell (`:3200`), and this connector (`:4200`).

<details>
<summary>Without Docker: run the four Node entrypoints directly</summary>

Each server runs in the foreground, so background them (or use four terminals). The environment below
is not optional: without `EVIDENCE_API_ENDPOINT` the Runtime API issues descriptors pointing at
`http://localhost:3100`, where nothing listens in this layout, and learner evidence would be posted
into the void instead of reaching the results read model.

```sh
pnpm install && pnpm build
set -a; . ./.env; set +a   # loads the three secrets from step 1

PORT=4000 IES_PUBLIC_ISSUER=http://localhost:4000 \
  node dist/packages/stub-ies/src/server.js &
PORT=4100 \
  node dist/packages/stub-roster/src/server.js &
PORT=3000 RUNTIME_PUBLIC_ISSUER=http://localhost:3000 \
  PLAYER_SHELL_ORIGIN=http://localhost:3200 \
  EVIDENCE_API_ENDPOINT=http://localhost:3000/api/v1/evidence/statements \
  IES_ISSUER=http://localhost:4000 \
  IES_JWKS_URL=http://localhost:4000/.well-known/jwks.json \
  node dist/src/server.js &
PORT=4200 AUTH_MODE=poc RUNTIME_API_BASE=http://localhost:3000 \
  EVIDENCE_API_BASE=http://localhost:3000 \
  ROSTER_API_BASE=http://localhost:4100 \
  node dist/packages/mcp-connector/src/server.js &
```

Stop them again with `kill %1 %2 %3 %4`. The Player Shell is not included — it is a static bundle, and
nothing in this runbook up to step 4 needs a browser.

</details>

Check all four came up:

```sh
for p in 4000 4100 3000 4200; do printf 'port %s: ' $p; curl -s localhost:$p/health; echo; done
```

The connector reports `{"status":"ok", … "auth_mode":"poc","production":false}`.

### 3. Connect Claude Code

Claude Code speaks the streamable HTTP transport and can send a static header, which is what this
connector's PoC bearer mode needs:

```sh
claude mcp add --transport http lorb http://127.0.0.1:4200/mcp \
  --header "Authorization: Bearer $MCP_POC_BEARER_TOKEN"
claude mcp list          # -> lorb: http://127.0.0.1:4200/mcp (HTTP) - Connected
```

Then ask Claude something like:

> Read the recent topics for class `9c1f0a5e-7d2b-4f83-9a6c-2b8e5d4a1c30`, draft a five-question quiz
> on the most recent one, and create it. Don't assign it yet.

The two seeded classes are `9c1f0a5e-7d2b-4f83-9a6c-2b8e5d4a1c30` (9B Mathematics, 8 learners) and
`4d7b62e1-3a90-4c5e-8f21-6ac9b0e7d452` (10A Combined Science, 5 learners).

`assign_quiz` is the consent-gated step: its description tells a compliant host to confirm with the
teacher first, so expect Claude to ask before calling it. After assigning, read
`quiz://{objectId}/results` — it will show the class assigned, nobody started, and no average yet
until learners actually sit the quiz.

### 4. Poke it by hand instead

`npx @modelcontextprotocol/inspector` accepts a URL and a bearer token, and is the quickest way to see
raw `tools/list` and `resources/read` traffic without an agent in the loop.

### What does not work yet: claude.ai and Claude Desktop

Custom connectors there need a **public HTTPS URL** and discover authorization over OAuth. This
connector implements neither: it has one pre-shared bearer token and no authorization server, and
there is no field in those UIs for a static bearer header. Wiring OAuth is BLK-08 work and is
deliberately not in this PoC.

Tunnelling the local connector to a public URL is technically possible and **is not recommended**:
anyone holding the bearer token could then create catalogue entries and assign work to the synthetic
roster, over an uncertified surface with no privacy or security review behind it (BLK-07, BLK-08).

## Open blockers

Untouched by this package: BLK-02, BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. In particular BLK-07
(privacy) and BLK-08 (security) bear directly on it — an agent-facing surface that resolves class
rosters and reads learner outcomes needs a privacy design and a real authorization design before it is
anything more than a demonstration.
