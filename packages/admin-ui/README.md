# Administration Workspace

The repository-scoped administration surface: repository lifecycle, player and player-version
registration and activation, launch-policy authoring and activation, approvals, and the audit trail.

It is not a learner or operations surface. It *is* the publisher surface: the Publisher API is
reachable from here, because a catalogue an administrator can only add to is barely more operable
than one they cannot add to at all.

## What it manages

| Area | Actions |
| --- | --- |
| Repositories | Create, suspend, retire; grant and revoke membership |
| Membership | `repository_owner`, `repository_operator`, `repository_reader` — the repository-scoped authorisation every other action is checked against |
| Players | Register a player; register, approve, activate and suspend an immutable version |
| Launch policies | Create, version, publish and activate the rules that route a renderer |
| Approvals | Request → approve → execute, with separation of duties |
| Audit | Every administrative decision, allowed or denied, append-only |
| Learning objects | Author a quiz or register a packaged module; edit the catalogue entry; publish a new version; suspend, restore, retire or delete; smart-link creation and revocation |

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

## Editing the catalogue

The workspace draws one line through everything on the Learning objects pages, and it is worth
stating plainly because it is the line an administrator would otherwise expect to be somewhere else.

**What the catalogue says** — a title, a description, a stated duration, a kind — is edited in place
and saved. `PATCH /api/v1/publisher/learning-objects/:id` accepts those four fields and no others, so
an edit here can never move the module path, the package digest or the version chain.

**What is delivered** is versioned, never edited. Saving a quiz's questions publishes a new content
version bound to a new object version and supersedes the current one; publishing a packaged module's
new bundle does the same. Attempts already recorded stay bound to the version they were launched
against, and the superseded content stays readable, so a learner is never reported against questions
they did not see.

**Withdrawing** has three strengths. Suspend takes an object out of the catalogue and can be undone.
Retire is the end of the line and cannot. Delete removes the object outright and is refused — by the
API, and by a foreign key underneath it — for any object that has ever been launched or assigned:
evidence outlives the catalogue.

An authored quiz's right answers are shown to whoever edits it, which is the one place the marking
key leaves the learner-facing content route. It is served only to an administrator with membership of
the repository, never cached, and the read is written to the audit trail.

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
