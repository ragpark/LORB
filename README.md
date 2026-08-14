# LORB-001 MVP

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.** This thin slice is not production-ready and must not be deployed to a shared environment. It makes no compliance claim.

This repository demonstrates one native-web-package launch, an embedded sandboxed player, attempt state/completion, evidence outboxing, and forwarding to test-only stubs. Attempt-scoped state is embedded as JSON in the `attempt` row so the fixed five-table model is retained.

## Learning content examples

Three synthetic learning objects are seeded in the Runtime API's non-production catalogue for presentation in the Player Shell, and are discoverable in the Mock Consumer catalogue, the Ops Console (Learning objects, Package versions, Test launcher), and the Administration workspace (Learning objects):

- **Maths foundations: ratios and proportion** (`packages/example-module`) — the original native-web-package activity with a single completion checkpoint.
- **Reflective Practice Studio** (`packages/example-react-xapi-experience`) — a React web experience. On completion it emits an xAPI statement over the Player Shell's `evidence.emit` channel; the Runtime API queues it in the evidence outbox for the Evidence Forwarder to deliver to the LORB learning record store (`stub-lrs` locally).
- **Career Coach Check-in** (`packages/example-coaching-chatbot`) — a chatbot-like coaching tool that guides a learner through a short scripted, reflective conversation before completing the activity.

Each learning object routes to its own content package at launch (`POST /api/v1/runtime/launches` resolves `package_url` from the requested `object_id`); an unrecognised object falls back to the default package, unchanged from prior behaviour.

## Smart links

Each PUBLISHED learning object can have a durable, revocable "smart link" — a shareable URL that opens straight into the Player Shell without a consumer app or IES login. From the Administration workspace's **Learning objects** page, an admin can create/copy or revoke the link for any published object.

Opening the link (`GET /api/v1/runtime/smart-links/:token` on the Runtime API) mints a fresh attempt and launch descriptor and 302-redirects to the same `${playerOrigin}/#descriptor=...` shape `/launches` already produces, so the Player Shell itself is unchanged. The learner is identified by a random pseudonymous ID stored in a long-lived cookie set on first visit (not a real identity) — the same browser gets the same pseudonym, and therefore consistent evidence actor binding, on every subsequent open, but a new attempt each time. Revoking a link disables both the admin record and future redemptions immediately; a new "Create smart link" click after revocation mints a fresh, unrelated token.

This intentionally lets a learner reach the Player Shell without an IES-issued token, which is a **material change to the launch surface** under this repository's own governance rule below, and needs the same human LORB-001 re-review as any other change to the launch descriptor or pseudonymisation function. It does not add a new identity provider or entitlement engine — it reuses the existing descriptor issuance and HMAC pseudonym derivation unchanged, only skipping the IES login step — but the tradeoff (anyone holding the link can launch the object, indefinitely, anonymously) should be named explicitly rather than treated as a detail.

## How to run

Use Node.js 20 and pnpm 9. Copy `.env.example` to `.env`, replace the pseudonym placeholder with 32 random bytes encoded as hex, and create the configured P-256 private key. Then run `docker compose up -d`, `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm dev`. This starts the Runtime API, Evidence API, player shell, evidence forwarder, stub IES, and stub LRS for local development only.

## Railway deployment (review environments only)

The included `Dockerfile` and `railway.json` deploy the Runtime API as one Railway service. This does **not** remove the draft status or open blockers above, and it must not be treated as a production or shared-environment approval. A review launch additionally requires separate Mock Consumer, Player Shell, and synthetic IES services; use the complete variable matrix and connectivity checklist in [`packages/mock-consumer/README-deploy.md`](packages/mock-consumer/README-deploy.md).

1. Push the repository to a Git provider and create a Railway project using **Deploy from GitHub repo** (or run `railway up` from the repository root).
2. Add a **PostgreSQL** service from the project canvas (**+ New → Database → Add PostgreSQL**). In the Runtime API service's **Variables** tab, add `DATABASE_URL=${{Postgres.DATABASE_URL}}` (change `Postgres` if you renamed the database service). Railway's pre-deploy command applies the SQL migration and idempotently seeds a demo repository, learning object, and package version on each deploy.
3. In the Runtime API service's **Variables** tab, add `PSEUDONYM_TENANT_SECRET` with the output of `openssl rand -hex 32`. The CORS allow-list always contains the local consumer and `https://lorb-production-consumer.up.railway.app`. Optionally set `ALLOWED_CONSUMER_ORIGINS` to add a comma-separated list of exact origins (no paths, trailing slashes, or wildcards); configured origins are merged with the built-in consumers so a stale Railway variable cannot disable the hosted consumer. Do not add `PORT`; Railway injects it for the service.
4. Generate a public domain in **Settings → Networking**. Railway builds the multi-stage image, runs the database setup, checks `/health`, and starts the server on `0.0.0.0:$PORT`.
5. Open `https://<your-domain>/` for the API index, or confirm the deployment with `curl https://<your-domain>/health`; it should return `{"status":"ok"}`. Runtime routes are under `/api/v1/runtime`, and the JWKS document is at `/api/v1/runtime/jwks`.

The public URL is an API, not a browser UI; the root response is an endpoint index. You do not need a second Railway service for the Runtime API itself. The deployed-equivalent integration does require the separately configured Player Shell and synthetic IES services described below; the synthetic IES remains strictly non-production.

The migration and seed make PostgreSQL ready and verify its connection during pre-deploy, but the current Runtime API still uses its in-memory MVP store. Attempts and evidence are therefore lost on restart. PostgreSQL-backed request handling is follow-up work; the seeded rows must not be represented as end-to-end persistence support. To rerun setup locally, set `DATABASE_URL` and run `pnpm db:setup`.

## Enforced anti-requirements

The automated suite enforces all 15 MVP controls: descriptor PII rejection; pinned player references; immutable package-version UUIDs; launch idempotency required and replayed; runtime token audience; evidence actor binding; statement UUID validation and deduplication; no wildcard or unlisted postMessage origins; iframe sandbox isolation; sensitive-log redaction; no wildcard CORS; and legal attempt transitions. See `tests/anti-requirements/README-anti-requirements.md`. Approximately 75 wider LORB-001 anti-requirements remain explicitly out of this MVP.

## Open blockers

This work cannot progress beyond local development while BLK-02 (portfolio reuse), BLK-03 (accountable owner), BLK-07 (privacy), BLK-08 (security), BLK-09 (accessibility), and BLK-11 (operational design) remain open. Stubs additionally document their removal blockers.

Any material change to the launch descriptor, pseudonymisation function, error envelope, or anti-requirement enforcement requires human re-review against LORB-001.

## Deployed launch services

The deployed-equivalent launch is split into independently HTTPS-terminated services: Runtime API (`Dockerfile`), synthetic non-production IES (`Dockerfile.stub-ies`), Player Shell (`Dockerfile.player-shell`), Evidence API, and the consumer. Configure Runtime with `IES_ISSUER`, `IES_JWKS_URL`, `RUNTIME_PUBLIC_ISSUER`, `PLAYER_SHELL_ORIGIN`, `EVIDENCE_API_ENDPOINT`, and `PACKAGE_PUBLIC_URL`. All values are public absolute HTTPS URLs in shared environments. The consumer derives the descriptor issuer from the origin of `VITE_RUNTIME_API_BASE`; `VITE_RUNTIME_ISSUER` is an optional explicit override. Descriptor trust is rooted in the Runtime JWKS, while the IES issuer is used only for Runtime access tokens.

The synthetic IES accepts only `synthetic-*` subjects at `POST /dev-login`, issues ten-minute ES256 tokens with audience `lorb-runtime`, and publishes its key at `/.well-known/jwks.json`. It is strictly a non-production identity simulator.

For the mock consumer image, do not configure `VITE_RUNTIME_ISSUER` in Railway: the image deliberately does not accept or require that build argument and derives the issuer origin from `VITE_RUNTIME_API_BASE`. `VITE_STUB_IES_ISSUER` and `VITE_STUB_IES_LOGIN_URL` must use the real public domain of the deployed synthetic IES; placeholder values such as `<stub-ies-non-production-host>` are not valid configuration. If a Railway build log still contains `test -n "${VITE_RUNTIME_ISSUER}"`, Railway is building an older revision of `Dockerfile.mock-consumer`; deploy the commit containing this paragraph and rebuild without the old cached deployment.
