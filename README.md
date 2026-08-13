# LORB-001 MVP

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.** This thin slice is not production-ready and must not be deployed to a shared environment. It makes no compliance claim.

This repository demonstrates one native-web-package launch, an embedded sandboxed player, attempt state/completion, evidence outboxing, and forwarding to test-only stubs. Attempt-scoped state is embedded as JSON in the `attempt` row so the fixed five-table model is retained.

## How to run

Use Node.js 20 and pnpm 9. Copy `.env.example` to `.env`, replace the pseudonym placeholder with 32 random bytes encoded as hex, and create the configured P-256 private key. Then run `docker compose up -d`, `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm dev`. This starts the Runtime API, Evidence API, player shell, evidence forwarder, stub IES, and stub LRS for local development only.

## Railway deployment (review environments only)

The included `Dockerfile` and `railway.json` deploy the Runtime API as one Railway service. This does **not** remove the draft status or open blockers above, and it must not be treated as a production or shared-environment approval. The Evidence API, player shell, forwarder, and test-only IES/LRS stubs remain local components and are not started by this deployment.

1. Push the repository to a Git provider and create a Railway project using **Deploy from GitHub repo** (or run `railway up` from the repository root).
2. Add a **PostgreSQL** service from the project canvas (**+ New → Database → Add PostgreSQL**). In the Runtime API service's **Variables** tab, add `DATABASE_URL=${{Postgres.DATABASE_URL}}` (change `Postgres` if you renamed the database service). Railway's pre-deploy command applies the SQL migration and idempotently seeds a demo repository, learning object, and package version on each deploy.
3. In the Runtime API service's **Variables** tab, add `PSEUDONYM_TENANT_SECRET` with the output of `openssl rand -hex 32`. Optionally set `ALLOWED_CONSUMER_ORIGINS` to a comma-separated list of exact HTTPS origins. Do not add `PORT`; Railway injects it for the service.
4. Generate a public domain in **Settings → Networking**. Railway builds the multi-stage image, runs the database setup, checks `/health`, and starts the server on `0.0.0.0:$PORT`.
5. Open `https://<your-domain>/` for the API index, or confirm the deployment with `curl https://<your-domain>/health`; it should return `{"status":"ok"}`. Runtime routes are under `/api/v1/runtime`, and the JWKS document is at `/api/v1/runtime/jwks`.

The public URL is an API, not a browser UI; the new root response is an endpoint index. You do not need a separate Railway “API component”: this repository service is the Runtime API. Do not create separate Evidence API, player-shell, IES, or LRS services from this revision. They still contain localhost assumptions and test-only keys and cannot form a working hosted stack without further implementation.

The migration and seed make PostgreSQL ready and verify its connection during pre-deploy, but the current Runtime API still uses its in-memory MVP store. Attempts and evidence are therefore lost on restart. PostgreSQL-backed request handling is follow-up work; the seeded rows must not be represented as end-to-end persistence support. To rerun setup locally, set `DATABASE_URL` and run `pnpm db:setup`.

## Enforced anti-requirements

The automated suite enforces all 15 MVP controls: descriptor PII rejection; pinned player references; immutable package-version UUIDs; launch idempotency required and replayed; runtime token audience; evidence actor binding; statement UUID validation and deduplication; no wildcard or unlisted postMessage origins; iframe sandbox isolation; sensitive-log redaction; no wildcard CORS; and legal attempt transitions. See `tests/anti-requirements/README-anti-requirements.md`. Approximately 75 wider LORB-001 anti-requirements remain explicitly out of this MVP.

## Open blockers

This work cannot progress beyond local development while BLK-02 (portfolio reuse), BLK-03 (accountable owner), BLK-07 (privacy), BLK-08 (security), BLK-09 (accessibility), and BLK-11 (operational design) remain open. Stubs additionally document their removal blockers.

Any material change to the launch descriptor, pseudonymisation function, error envelope, or anti-requirement enforcement requires human re-review against LORB-001.
