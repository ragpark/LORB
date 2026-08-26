# Learner Portal

The learner-facing surface: sign in, browse the catalogue, launch an activity, and see it through to
a completion summary. It also carries the teacher-facing roster area — classes, learners, assignments
and results.

## The launch flow

1. Sign in through the identity provider (authorization code with PKCE; the token lives in memory and
   is cleared when the tab closes).
2. Browse the catalogue for a repository, and open an activity.
3. Launch it. The portal verifies the returned descriptor against the Runtime's published JWKS before
   opening anything, and refuses a `player_url` whose origin is not the configured Player Shell.
4. The activity runs in an iframe sandboxed without `allow-same-origin`. The portal accepts messages
   only from that iframe, only from an allow-listed origin, and only in the strict envelope shape.
5. Completion, exit or error produces a summary carrying the correlation identifier, which is the one
   thing a learner can usefully quote to support.

## The roster area

Teachers create classes, add learners by the identifier their identity provider issues, record what
has recently been taught, assign an activity to a whole class, and read the results.

A learner's identifier and their LORB pseudonym are never stored in the same row. Results are matched
by recomputing the pseudonym at read time, so the pairing exists only for the duration of the request
that needed it and there is no standing re-identification table. A display name is for the teacher's
screen alone: it never reaches a launch descriptor or an xAPI statement, and the descriptor schema
would reject it if it tried.

An assignment also snapshots who was in the class at the time, so a learner who joins later is not
shown as having missed work they were never given, and one who leaves does not vanish from a record
that still counts them.

## Running it

```sh
pnpm --filter learner-portal dev     # http://localhost:5174
```

`VITE_ENVIRONMENT_LABEL` must be `PRODUCTION`, `STAGING` or `DEVELOPMENT`, and outside `DEVELOPMENT`
the portal refuses to start without `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID` — a deployed portal
that fell back to the local sign-in would accept any subject a caller named.

`VITE_ALLOWED_SHELL_ORIGINS` is an explicit allow-list; an empty list or a wildcard is a start-up
failure. Deployment: [README-deploy.md](README-deploy.md).

## Enforced controls

Environment notice placement and absence in production; identity-field leak prevention; iframe
sandboxing; origin and source validation on every message; strict message envelopes; idempotency;
correlation; session-only tokens; no markup injection; skip navigation; accessible dialog behaviour;
signed descriptor verification before any content is opened; token clearing on tab close; the local
sign-in confined to development; and the twelve-code error taxonomy implemented as specified, with
nothing invented beyond it.

See `tests/anti-requirements/README-anti-requirements.md`.
