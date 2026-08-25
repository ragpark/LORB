# LORB Administration Workspace

> **DRAFT — HUMAN REVIEW REQUIRED — NOT CERTIFIED. Local development and non-production Railway only. Do not use with real learner data.**

A repository-scoped administration surface for LORB-001: repository lifecycle, player/player-version
registration and activation, launch-policy authoring and activation, separation-of-duties approvals,
and an append-only audit trail. It implements Wave 1 of the LORB-001 Administration Workspace brief.
It is not a Learner, Teacher, Publisher, or Operations Console surface.

## Wave 1 vs Wave 2 scope

**In Wave 1:** repository create/suspend/retire; repository-scoped membership (owner/operator/reader
roles); player and player-version registration, approval, activation, suspension; launch-policy
creation, versioning, publish, and activation; the approval-request lifecycle (request → approve →
execute, with separation of duties enforced at the UI, API, and Postgres layers); an append-only audit
log; and launch-policy consultation by the Runtime API's `/launches` resolver.

**Deferred to Wave 2 (not implemented):** the launch-policy Simulate action (present in the UI, disabled,
with a "Deferred to Wave 2" tooltip); a Publisher UI cross-slice update (see "Known gaps" below — no
such package exists in this repository to update); and any change to descriptor verification, PDS
theming, or production certification.

## Run locally

Use Node 20 LTS and pnpm 9. Run `pnpm install`, then `pnpm --filter admin-ui dev`. Copy only the
permitted `VITE_*` variables from `.env.example`; `VITE_ENVIRONMENT_LABEL` must be `LOCAL-DEV`. The
workspace is available at `http://localhost:5176` and requires the Runtime API (with `DATABASE_URL`,
`ADMIN_ALLOWED_ROLES`, and `ADMIN_APPROVAL_REQUIRED_FOR` set — see the root `.env.example`) and the
`dev-identity` synthetic identity service running alongside it.

## Railway non-production

Build `packages/admin-ui/dist` and host it in a distinct `lorb-admin-ui` Railway non-production project.
Set `VITE_ENVIRONMENT_LABEL=RAILWAY-NON-PROD` and confirm all API origins are non-production. See
[README-deploy.md](README-deploy.md).

## Enforced anti-requirements

25 automated controls from Section 13 of the brief are tested in
[`tests/anti-requirements/admin-ui-enforcement.spec.ts`](tests/anti-requirements/README-anti-requirements.md)
(UI-side) and `tests/runtime-api/admin-enforcement.spec.ts` at the repo root (API/DB-side). The full
enumerated list, with spec cross-references and documented gaps against the brief, lives in
[`tests/anti-requirements/README-anti-requirements.md`](tests/anti-requirements/README-anti-requirements.md).

## Production blockers

BLK-03 (accountable owner), BLK-07 (Pearson Design System layer), BLK-08 (Railway procurement/security
assessment), BLK-09 (UK residency), and BLK-11 (launch-policy resolution production hardening) remain
open. The stub IES, synthetic pseudonym projection, and descriptor verification carried over from the
Runtime API are also production blockers. Real learner data is prohibited.

Changes to immutability enforcement, the approval workflow, RBAC/ABAC, audit-record handling, or any of
the 25 anti-requirements above must be re-reviewed against LORB-001 before merge.
