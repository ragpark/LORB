# LORB-001 MVP

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.** This thin slice is not production-ready and must not be deployed to a shared environment. It makes no compliance claim.

This repository demonstrates one native-web-package launch, an embedded sandboxed player, attempt state/completion, evidence outboxing, and forwarding to test-only stubs. Attempt-scoped state is embedded as JSON in the `attempt` row so the fixed five-table model is retained.

## How to run

Use Node.js 20 and pnpm 9. Copy `.env.example` to `.env`, replace the pseudonym placeholder with 32 random bytes encoded as hex, and create the configured P-256 private key. Then run `docker compose up -d`, `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm dev`. This starts the Runtime API, Evidence API, player shell, evidence forwarder, stub IES, and stub LRS for local development only.

## Railway deployment (review environments only)

The included `Dockerfile` and `railway.json` deploy the Runtime API as one Railway service. This does **not** remove the draft status or open blockers above, and it must not be treated as a production or shared-environment approval. The Evidence API, player shell, forwarder, and test-only IES/LRS stubs remain local components and are not started by this deployment.

1. Push the repository to a Git provider and create a Railway project using **Deploy from GitHub repo** (or run `railway up` from the repository root).
2. In the service's **Variables** tab, add `PSEUDONYM_TENANT_SECRET` with the output of `openssl rand -hex 32`. Optionally set `ALLOWED_CONSUMER_ORIGINS` to a comma-separated list of exact HTTPS origins. Do not add `PORT`; Railway injects it for the service.
3. Generate a public domain in **Settings → Networking**. Railway builds the multi-stage image, checks `/health`, and starts the server on `0.0.0.0:$PORT`.
4. Confirm the deployment with `curl https://<your-domain>/health`; it should return `{"status":"ok"}`. Runtime routes are under `/api/v1/runtime`, and the JWKS document is at `/api/v1/runtime/jwks`.

For a Railway PostgreSQL service, add PostgreSQL from the project canvas and set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on this service. The current in-memory MVP does not consume that variable yet, so data is lost on every restart; the database is only preparation for replacing the in-memory store and must not be represented as persistence support.

## Enforced anti-requirements

The automated suite enforces all 15 MVP controls: descriptor PII rejection; pinned player references; immutable package-version UUIDs; launch idempotency required and replayed; runtime token audience; evidence actor binding; statement UUID validation and deduplication; no wildcard or unlisted postMessage origins; iframe sandbox isolation; sensitive-log redaction; no wildcard CORS; and legal attempt transitions. See `tests/anti-requirements/README-anti-requirements.md`. Approximately 75 wider LORB-001 anti-requirements remain explicitly out of this MVP.

## Open blockers

This work cannot progress beyond local development while BLK-02 (portfolio reuse), BLK-03 (accountable owner), BLK-07 (privacy), BLK-08 (security), BLK-09 (accessibility), and BLK-11 (operational design) remain open. Stubs additionally document their removal blockers.

Any material change to the launch descriptor, pseudonymisation function, error envelope, or anti-requirement enforcement requires human re-review against LORB-001.
