# LORB-001 MVP

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED — LOCAL DEV ONLY.** This thin slice is not production-ready and must not be deployed to a shared environment. It makes no compliance claim.

This repository demonstrates one native-web-package launch, an embedded sandboxed player, attempt state/completion, evidence outboxing, and forwarding to test-only stubs. Attempt-scoped state is embedded as JSON in the `attempt` row so the fixed five-table model is retained.

## How to run

Use Node.js 20 and pnpm 9. Copy `.env.example` to `.env`, replace the pseudonym placeholder with 32 random bytes encoded as hex, and create the configured P-256 private key. Then run `docker compose up -d`, `pnpm install`, `pnpm build`, `pnpm test`, and `pnpm dev`. This starts the Runtime API, Evidence API, player shell, evidence forwarder, stub IES, and stub LRS for local development only.

## Enforced anti-requirements

The automated suite enforces all 15 MVP controls: descriptor PII rejection; pinned player references; immutable package-version UUIDs; launch idempotency required and replayed; runtime token audience; evidence actor binding; statement UUID validation and deduplication; no wildcard or unlisted postMessage origins; iframe sandbox isolation; sensitive-log redaction; no wildcard CORS; and legal attempt transitions. See `tests/anti-requirements/README-anti-requirements.md`. Approximately 75 wider LORB-001 anti-requirements remain explicitly out of this MVP.

## Open blockers

This work cannot progress beyond local development while BLK-02 (portfolio reuse), BLK-03 (accountable owner), BLK-07 (privacy), BLK-08 (security), BLK-09 (accessibility), and BLK-11 (operational design) remain open. Stubs additionally document their removal blockers.

Any material change to the launch descriptor, pseudonymisation function, error envelope, or anti-requirement enforcement requires human re-review against LORB-001.
