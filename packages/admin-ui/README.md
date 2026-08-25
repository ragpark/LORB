# Administration Workspace

The repository-scoped administration surface: repository lifecycle, player and player-version
registration and activation, launch-policy authoring and activation, approvals, and the audit trail.

It is not a learner, publisher or operations surface.

## What it manages

| Area | Actions |
| --- | --- |
| Repositories | Create, suspend, retire; grant and revoke membership |
| Membership | `repository_owner`, `repository_operator`, `repository_reader` — the repository-scoped authorisation every other action is checked against |
| Players | Register a player; register, approve, activate and suspend an immutable version |
| Launch policies | Create, version, publish and activate the rules that route a renderer |
| Approvals | Request → approve → execute, with separation of duties |
| Audit | Every administrative decision, allowed or denied, append-only |
| Learning objects | The catalogue, and smart-link creation and revocation |

## Separation of duties

Actions listed in `ADMIN_APPROVAL_REQUIRED_FOR` cannot be performed directly: they create an approval
request, a *different* administrator approves it, and only then can it be executed.

Three layers enforce it, and the last one is the one that matters:

1. The workspace disables the approve control for the principal who requested it.
2. The API refuses a self-approval.
3. A Postgres `CHECK` constraint refuses a row whose approver equals its requester.

The first two can be bypassed by a client or a bug. The third cannot be bypassed at all, which is why
it exists as well as, not instead of, the other two.

## Immutability

A player version's module URL, origin, integrity hash and supported profiles are frozen once it
leaves `REGISTERED`/`TESTING` — enforced by a database trigger, not by application code. A published
launch-policy version's rules and semver are frozen the same way. Audit records reject updates and
deletes outright.

The point is that changing what a launch resolves to is always a new version somebody approved, never
an edit somebody made.

## Sign-in

Through your identity provider, using authorization code with PKCE. An administrator is distinguished
by the role claim your provider is configured to emit; the claim name is `OIDC_ROLE_CLAIM` and the
accepted values are `ADMIN_ALLOWED_ROLES`. A token without one gets 403 on every route here, which is
the right outcome for a learner's token.

The signed-in administrator is identified by their pseudonym, from `GET /api/v1/admin/whoami`. No raw
subject is rendered anywhere in the workspace.

## Running it

```sh
pnpm --filter admin-ui dev      # http://localhost:5176
```

Needs the Runtime API running with `DATABASE_URL`, `ADMIN_ALLOWED_ROLES` and
`ADMIN_APPROVAL_REQUIRED_FOR` set. `VITE_ENVIRONMENT_LABEL` must be `PRODUCTION`, `STAGING` or
`DEVELOPMENT`. Deployment: [README-deploy.md](README-deploy.md).

## Deferred

The launch-policy **Simulate** action is present in the interface and disabled, with a tooltip saying
so. It would let an administrator see which player a hypothetical launch would resolve to without
issuing one. Nothing depends on it.

## Enforced controls

UI-side controls in [`tests/anti-requirements/`](tests/anti-requirements/README-anti-requirements.md);
API and database controls in `tests/runtime-api/admin-enforcement.spec.ts` at the repository root.
Between them they cover the environment notice, pseudonym-only display, session-only token storage,
no unsafe HTML, correlation and idempotency on every state change, the disabled self-approval control,
authorization redaction in diagnostics, immutability enforcement, RBAC and repository-scoped ABAC
denial, audit transactionality, and the launch-policy resolver's behaviour when an object pins its own
player.
