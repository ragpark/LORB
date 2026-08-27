# Learning Record Store

The durable end of the evidence trail. Accepts xAPI statements from the evidence forwarder, stores
them immutably, and answers queries about them.

Until now this box on the architecture diagram belonged to somebody else: `LRS_ENDPOINT` pointed at a
commercial learning record store, or in development at `packages/dev-lrs`, which holds statements in
memory and says on its own first line that it is never a deployment target. A platform whose stated
purpose is to own the evidence trail should be able to hold that trail itself.

## What it speaks

xAPI 1.0.3, the statements resource:

| Request | Behaviour |
| --- | --- |
| `PUT /statements?statementId=…` | Stores one statement under the id the caller names. `204` when stored, `204` again on a redelivery, `409` when a *different* statement already holds that id |
| `POST /statements` | Stores one statement or a batch; answers `200` with the ids |
| `GET /statements?statementId=…` | One statement, voided or not |
| `GET /statements?…` | A filtered page: `agent`, `verb`, `activity`, `registration`, `since`, `until`, `limit`, `ascending`, plus `attempt_id` and `repository_id`, which are not xAPI and are the two questions an operator actually asks. Answers `{statements, more}` |

`agent` takes a JSON-encoded xAPI Agent, and this store's actors are account pseudonyms, so the
filter is that account's name. A bare pseudonym is accepted too, because it is what the platform's
own tools pass. An Agent identified by `mbox` or `openid` matches nothing rather than everything:
there is no statement here it could be about.

Every statement served carries a `stored` assigned by this store, whatever the sender said — xAPI
reserves that field for the store, and provenance that a sender can set is not provenance.
| `GET /about` | The version it speaks. Unauthenticated, per the specification |
| `GET /health`, `GET /ready` | Liveness, and readiness including the database |

Not implemented, deliberately, and additive when they are wanted: attachments, signed statements, and
the state, agent-profile and activity-profile resources. Nothing in this platform emits them.

## What it refuses

**A statement that would overwrite one already stored.** xAPI makes the statement id the
deduplication key. A redelivery of the same statement is a no-op — which is exactly what makes the
forwarder's retry safe — and a *different* statement under a taken id is a `409` rather than a
silent overwrite.

The comparison is a digest of the statement *as it arrived*, with the top-level `id` and `stored`
excluded and nothing else — checked first, and backed by a structural comparison against the stored
payload for the one case a digest cannot settle. A statement sent without a `timestamp` is stored
with one this store assigned, so a client that reads it back and sends that authoritative
representation in again is offering something that never arrived in that form. That is the same
statement echoed, not a conflicting one, and the fields this store assigns are excluded from the
comparison: `id`, `stored`, and `timestamp` where the arriving statement asserts none. Digesting what is stored instead would break idempotency for a statement
that carries no `timestamp`, because this store fills one in from its own clock and the same request
would get a new identity every time it was sent. And excluding `stored` at every depth rather than
at the top would collapse two genuinely different statements whose telemetry happens to use that
word — reported as a duplicate, with the first silently kept.

A batch on `POST` is written in one transaction, and is checked against its own earlier entries as
well as against what is stored: two entries sharing an id are both absent from the store when the
batch arrives, so a check that only reads the store would write the first and report success for
both. Stopping at the first conflict and keeping what came before it leaves the sender unable to
tell which half landed, and — for entries it supplied no id for — with statements stored under ids
it was never told.

**An actor that identifies a person.** LORB's evidence is pseudonymous by construction: the actor on
every statement is an HMAC, and the mapping back to a learner is never stored. A record store that
quietly accepted an `mbox`, an `openid`, an `mbox_sha1sum` or a display name would be the one place
that chain leaks. On by default; `LRS_REQUIRE_PSEUDONYMOUS_ACTOR=false` turns it off for a deployment
that genuinely receives identified statements from elsewhere.

**Any change to a statement once accepted.** Enforced by a database trigger rather than by
application code, because a store whose statements can be edited is not evidence of anything. The
trigger is an allow-list — only the three voiding columns may differ — rather than a list of
protected ones, so a column added later is frozen by default. That matters beyond the payload: the
facets decide which statements a reader is shown and in what order, and a payload nobody can edit is
worth little if the row's answer to "whose statement is this?" can be edited instead.

Voiding is the xAPI way to retract a statement, and it asserts a new statement rather than altering
the old one: a voided statement stops appearing in queries and is still there when asked for by id.

## Storage

Its own Postgres, not the platform's. They can share one — `LRS_DATABASE_URL` falls back to
`DATABASE_URL` so `pnpm dev` needs no second database — but a deployment should give this service a
database of its own, and the reason is not tidiness. Evidence outlives most of what surrounds it: a
catalogue can be rebuilt and a runtime restored from a backup taken this morning, while the record of
what a learner did has to survive both of those operations untouched. Two databases means restoring
one cannot roll the other back, and the store can be moved, sized and retained on its own terms.

Facets worth querying — actor, verb, object, registration, and LORB's repository, attempt
and package-version extensions — are pulled into columns; the whole statement is kept as `jsonb`, so
telemetry a learning object puts in `result.extensions` or `context.extensions` is stored whether or
not this platform has heard of it.

Paging is keyed on a sequence rather than on `stored_at`. A `timestamptz` holds microseconds and a
JavaScript `Date` holds milliseconds, so a cursor built from a returned timestamp sorts *before* the
row it came from — and that row is handed out again on the next page.

## Configuration

| Setting | Meaning |
| --- | --- |
| `LRS_DATABASE_URL` | This store's own database — see Storage. Falls back to `DATABASE_URL` for local development. Required in production |
| `LRS_ACCEPTED_BEARER_TOKENS` | Comma-separated tokens this store accepts |
| `LRS_ACCEPTED_BASIC_CREDENTIALS` | Comma-separated `username:password` pairs |
| `LRS_REQUIRE_PSEUDONYMOUS_ACTOR` | Default `true`. See above |
| `LRS_DEFAULT_LIMIT`, `LRS_MAX_LIMIT` | Page size default and ceiling (100, 1000) |
| `PORT` | Listener. Default 5000 |

Both credential settings are lists rather than single values on purpose: rotating the token the
forwarder uses means accepting the old and the new one for the length of the rollout, and a store
that accepts exactly one credential turns a rotation into an outage.

At least one credential and a database are required in production; without them the process names
what is missing and exits 78, as the rest of the platform does.

## Running it

```sh
pnpm serve:lrs           # http://localhost:5000
```

Migrations are applied at start-up under an advisory lock, so every replica may run them and exactly
one will. Point the platform at it by setting, on the Runtime API:

```
LRS_ENDPOINT=https://lrs.example/            # https outside development
LRS_BEARER_TOKEN=…                           # one of LRS_ACCEPTED_BEARER_TOKENS
```

## Tests

`tests/lrs/` at the repository root: the statement contract, the Postgres properties (durability, the
immutability trigger, concurrent delivery), and `delivery.spec.ts`, which runs the real forwarder
against the real store over a real socket — the one test that would catch this integration being
wrong in shape rather than in detail.
