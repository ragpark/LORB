# LORB Mock Consumer

**DRAFT — human review required — not certified. Non-production only.** This synthetic integration fixture is not ActiveHub, is not a Pearson product, and must never process real learner data.

## Controls

The 18 enforced controls cover banner ordering, mock and environment chrome, prohibited terminology, identity-field leak prevention, iframe sandboxing, origin/source validation, strict message envelopes, idempotency, correlation, session-only tokens, markup injection, safe learner copy, skip navigation, accessible dialogue behaviour, signed descriptor verification, token clearing and prohibited colour values. See `tests/anti-requirements/README-anti-requirements.md`.

BLK-03 leaves accountable ownership open. BLK-08 and BLK-09 prevent production and real-learner-data use. The supplied 12-code MVP error table is implemented; unspecified taxonomy entries are deliberately not invented.

## Run locally

Use Node 20 and pnpm 9. Copy `.env.example`, point every URL at the local synthetic stack, then run `pnpm install` and `pnpm --filter mock-consumer dev`. Open `http://localhost:5174`. Tokens are held only for the browser tab.

## Railway non-production

Build static output with `pnpm --filter mock-consumer build`; deployment details are in `README-deploy.md`. A production project is prohibited.

Changes to postMessage envelope handling, launch flow, error taxonomy or anti-requirement enforcement must be re-reviewed against LORB-001.
