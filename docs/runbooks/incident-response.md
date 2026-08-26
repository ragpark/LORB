# Incident response

Symptom first. Each section says how to confirm it, what causes it, and what to do.

## Triage in ninety seconds

```sh
curl -s https://runtime.lorb.example/ready | jq          # store reachable? which persistence?
curl -s https://runtime.lorb.example/metrics | grep -E '^lorb_(launches|evidence_forwarded)_total'
```

`/ready` returning 503 with `checks.store` set to an error is a database problem, not an application
one. `/ready` returning 503 with `checks.persistence` saying *in-memory state is not a system of
record* means a replica is running without `DATABASE_URL` in a production environment — take it out
of the load balancer immediately; anything it accepted is in that process and nowhere else.

---

## Learners cannot start an activity

### Every launch returns 401

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://runtime.lorb.example/api/v1/runtime/launches \
  -H "authorization: Bearer $TOKEN" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{…}'
```

Almost always the identity provider, in one of three ways:

- **Issuer mismatch.** `OIDC_ISSUER` is compared byte for byte against the token's `iss`. Several
  providers include a trailing slash. Copy it exactly from the provider's discovery document.
- **Audience mismatch.** The provider minted the token for a different API. Check `OIDC_AUDIENCE`
  against the `aud` claim.
- **Algorithm.** `OIDC_ALGORITHMS` must include what the provider actually signs with — RS256 for
  most.

Decode a rejected token (it is not a secret once it has been rejected) and compare `iss`, `aud` and
`alg` against the configuration. The service deliberately does not say which check failed, so this
comparison is the diagnosis.

### Every launch returns 404 OBJECT_NOT_FOUND

The object is not in the catalogue, is not `PUBLISHED`, or does not belong to the repository the
request names. This is deliberate: a launch never silently substitutes a default package for content
nobody registered.

```sh
psql "$DATABASE_URL" -c \
  "select object_id, status, repository_id from learning_object where object_id = '…'"
```

If the object is right but the repository is wrong, the consumer is sending a mismatched pair — fix
the caller, not the platform.

### Launches succeed but the player shows nothing

Compare the descriptor's `package_url` with what the Player Shell origin actually serves. A launch
policy routes the renderer for content that pins none; an object whose active package version is the
shared quiz player pins it, and that pin wins over the policy.

```sh
# decode the descriptor's package_url, then:
curl -sI "$PACKAGE_URL"     # must be 200 from the Player Shell origin
```

### Rate limited (429)

Expected under load; the limit is per replica, so the effective ceiling is
`RATE_LIMIT_LAUNCHES_PER_MINUTE` × replicas. Raise the limit or add replicas. If it is one caller,
that is what the limit is for.

---

## Learners lose their work

### State writes return 409 ATTEMPT_CONFLICT

Attempt state uses optimistic concurrency: the caller states the revision it read, and a write
against a stale revision is refused rather than overwriting a concurrent one. Two tabs on the same
attempt produce exactly this, and refusing is the correct behaviour.

It is a real fault only if a single session sees it repeatedly. Check whether the attempt has reached
a terminal state — a completed, abandoned or expired attempt refuses writes, and nothing reopens it:

```sh
psql "$DATABASE_URL" -c "select status, revision, expires_at from attempt where attempt_id = '…'"
```

### Attempts are unexpectedly EXPIRED

The maintenance loop terminates attempts whose session window has passed. The window is set at launch
from `DESCRIPTOR_TTL_SECONDS`. If learners routinely need longer than the window, raise the TTL
(bounded to 900 seconds) — do not disable the sweep, which is what stops attempts sitting in
`STARTED` for ever.

---

## Evidence is not reaching the learning record store

This is the one to take seriously, because evidence is learner achievement.

### Confirm where it is stuck

```sh
psql "$DATABASE_URL" -c "select status, count(*) from evidence_outbox group by status"
```

| Status | Meaning |
| --- | --- |
| `PENDING` | Accepted, waiting for the next forwarder pass |
| `IN_FLIGHT` | A worker holds it. Reclaimed automatically after five minutes if that worker died |
| `FAILED` | Delivery failed, retry scheduled with backoff |
| `DEAD_LETTER` | Attempts exhausted, or the receiver rejected it permanently. Visible and replayable |
| `FORWARDED` | Delivered |

Nothing is ever deleted: a database trigger refuses deletes on this table and refuses any update to
an accepted statement's payload.

### A growing PENDING backlog

The forwarder is not running or cannot reach the learning record store.

```sh
psql "$DATABASE_URL" -c "select * from worker_heartbeat where worker = 'evidence-forwarder'"
```

A stale `last_seen_at` means no replica is forwarding — check `EVIDENCE_FORWARDER_ENABLED` and
`LRS_ENDPOINT`, both of which the start-up log reports. A current heartbeat with a growing backlog
means delivery is failing; read `last_error`:

```sh
psql "$DATABASE_URL" -c \
  "select last_error, count(*) from evidence_outbox where status in ('FAILED','DEAD_LETTER')
   group by last_error order by 2 desc limit 5"
```

- `401:` or `403:` — credentials. Rotate or correct them, then requeue the dead letters (below).
- `network:` — connectivity or DNS.
- `400:` — the receiver rejected the statement shape. Not retried on purpose; a malformed statement
  will not become well-formed on the tenth attempt, and retrying starves the queue behind it.

### Requeue dead letters

```sh
curl -X POST "https://runtime.lorb.example/api/v1/evidence/outbox/$OUTBOX_ID/replay" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' -d "{\"statement_id\":\"$STATEMENT_ID\"}"
```

The `statement_id` must match, so a replay cannot be aimed at whatever happens to be in that outbox
slot. Requeuing is safe: the statement keeps its original UUID, which the learning record store
treats as the deduplication key, so one that did arrive is not recorded twice.

### The learning record store is down

Do nothing. Statements accumulate as `FAILED` with exponential backoff and are delivered when it
returns. Intervene only if the backlog approaches `EVIDENCE_FORWARDER_MAX_ATTEMPTS` passes, at which
point they become dead letters and need the requeue above.

---

## A replica is unhealthy

### Crash looping after a configuration change

Read the first log line. A production process that refuses to start prints
`refusing to start: invalid configuration` with **every** problem named at once, so one read tells
you everything to fix:

```json
{"level":"fatal","problems":["DATABASE_URL is required in production: …","OIDC_ISSUER is required in production"],"msg":"refusing to start: invalid configuration"}
```

Exit code 78 (`EX_CONFIG`) means exactly this and nothing else.

### Healthy but not ready

`/health` is deliberately dependency-free: a failing database must not get the process restarted,
because restarting it will not fix the database. `/ready` is the probe the load balancer should use.
Wire liveness to `/health` and readiness to `/ready`; wiring liveness to `/ready` turns a database
blip into a rolling restart of the whole fleet.

---

## Suspected credential exposure

| Exposed | Do |
| --- | --- |
| Descriptor signing key | Emergency rotation — [key-rotation.md](key-rotation.md). Learners mid-activity relaunch; no data is lost |
| Internal service token | Rotate on both sides. No learner is affected |
| Learning record store credential | Rotate, then requeue the dead letters the old credential produced |
| Pseudonym tenant secret | A data-protection incident first. Read [key-rotation.md](key-rotation.md) before touching it |
| An administrator's provider account | Revoke at the provider. Then read the audit trail for the exposure window: `select * from audit_record where actor_pseudonym = '…' order by created_at desc` |

## After any incident

Write down the recovery point, the recovery time, and which signal told you first. If the answer to
the last one is "a teacher emailed", the gap is in [observability.md](observability.md), and that is
the fix worth making.
