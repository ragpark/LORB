# LORB Operations Console

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED. Local development and non-production Railway only. Do not use with real learner data.**

A read-mostly React console for internal verification of the LORB-001 MVP with synthetic identities. It is not a Learner, Teacher, Publisher or full Administration surface.

## Run locally

Use Node 20 LTS and pnpm 9. Run `pnpm install`, then `pnpm --filter ops-console dev`. Copy only the permitted variables from `.env.example`; `VITE_ENVIRONMENT_LABEL` must be `LOCAL-DEV`. The console is available at `http://localhost:5173`.

## Railway non-production

Build `packages/ops-console/dist` and host it in the distinct `lorb-ops-console` Railway non-production project in EU West (Amsterdam). Set `VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD` and confirm all API origins are non-production. See [README-deploy.md](README-deploy.md).

## Enforced anti-requirements

The suite checks: banner ordering; environment label validation; leak detection; upstream-subject and tenant-secret redaction; correlation IDs; idempotency keys; fixed launch mode and locale; replay confirmation and provenance; expired-session redirect; no unsafe HTML; no wildcard messaging/CORS; session-only token storage; diagnostics authorisation redaction; first-tab-stop skip link; and accessible dialog focus/Escape behaviour.

## Production blockers

BLK-03 (accountable owner), BLK-08 (Railway procurement/security assessment), and BLK-09 (UK residency) remain open. The stub IES, synthetic projection fallback, descriptor verification and unresolved PDS commitment are also production blockers. Real learner data is prohibited.

Changes to descriptor verification, the banner, environment-label validation, or anti-requirement enforcement must be re-reviewed against LORB-001.
