# Key and secret rotation

Three pieces of key material, with three very different rotation stories. Read the right section.

| Material | Rotatable? | Blast radius of getting it wrong |
| --- | --- | --- |
| Descriptor signing key | Yes, with an overlap window | Every launch in flight fails to verify |
| Internal service token | Yes, with a brief dual-accept window | Assignments stop; no learner is affected |
| Pseudonym tenant secret | Effectively no | Every historical evidence record stops resolving to its learner |

---

## Descriptor signing key

**Rotate when:** on a schedule (annually is reasonable), or immediately on suspected exposure.

The key signs launch descriptors. The Player Shell and the Evidence API verify them against the
JWKS, resolving by the `kid` in the token header. That is what makes the overlap window possible: two
keys can be published at once, one signing and one only verifying.

### Planned rotation

Descriptor lifetime is `DESCRIPTOR_TTL_SECONDS` (600 seconds by default), so the overlap only has to
outlast that.

1. Generate the ring, with the new key active and the current one retiring:

   ```sh
   export DESCRIPTOR_KID=…                 # the current kid
   export DESCRIPTOR_PRIVATE_KEY_PEM="$(cat /path/to/current.pem)"
   pnpm keys:generate --rotate "$DESCRIPTOR_KID"
   ```

2. Set the printed JSON as `DESCRIPTOR_SIGNING_KEYS` on every replica, and remove
   `DESCRIPTOR_PRIVATE_KEY_PATH` / `DESCRIPTOR_KID` (the ring supersedes them). Roll the replicas.

3. Confirm both keys are published and the new one signs:

   ```sh
   curl -s https://runtime.lorb.example/api/v1/runtime/jwks | jq '.keys[].kid'
   # the ACTIVE key is first; both must be present
   ```

4. Wait out the descriptor lifetime plus a margin — 30 minutes is comfortable — then drop the
   `RETIRING` entry from `DESCRIPTOR_SIGNING_KEYS` and roll again.

At no point is a descriptor in a learner's browser invalidated.

### Emergency rotation (key exposed)

Skip the overlap. Set a ring containing only the new `ACTIVE` key and roll immediately. Every
descriptor issued under the old key stops verifying at once, so learners mid-activity see
`SESSION_EXPIRED` and have to relaunch. Attempt state is in the database, so nothing is lost; the
activity resumes from the state that was written.

Afterwards, check the audit trail and the launch metrics for the exposure window.

### What breaks if you get it wrong

Removing the old key too early: descriptors issued minutes ago fail verification, and every state
write and evidence post from those sessions gets 401. Symptom: a spike in
`lorb_http_requests_total{route="/api/v1/runtime/attempts/:attemptId/state",status="401"}` that
resolves on its own after the descriptor lifetime. Restore the retiring key to stop it immediately.

---

## Internal service token

**Rotate when:** on a schedule, or on suspected exposure.

`RUNTIME_INTERNAL_SERVICE_TOKEN` authenticates the agent connector to the Runtime API's internal
surface. It authorises the *service*, never a person — every route behind it derives the acting
teacher from an explicit agent-principal link — so rotating it affects assignment and quiz
registration, not any learner's access.

There is no dual-accept mode. Rotate by:

1. Generating a new value: `openssl rand -hex 32`.
2. Setting it on the Runtime API replicas and rolling them.
3. Setting the same value on the connector and rolling it.

Between steps 2 and 3 the connector's calls get 401. Keep the gap short, and do it outside teaching
hours. The Runtime API refuses to start if this token is configured to the same value as the agent
connector's own bearer token — that check exists so the two trust domains cannot silently collapse
into one.

---

## Pseudonym tenant secret

**Do not rotate this to a schedule.**

`PSEUDONYM_TENANT_SECRET` keys the HMAC that turns a learner's identifier into the pseudonymous actor
recorded on every attempt and every xAPI statement. It is not a session key: it is the identity
function for the entire evidence record.

Changing it means:

- Every learner's future pseudonym differs from their past one.
- Every attempt, assignment and statement already recorded belongs to an actor that no longer
  corresponds to anybody. Class results built by recomputing pseudonyms return nothing.
- Evidence already delivered to the learning record store keeps the old actor, so downstream reports
  split each learner into a before and an after.

None of that is recoverable without the old secret, because the mapping was deliberately never
stored — that is the property that stops the platform holding a standing re-identification table.

If the secret is genuinely compromised, this is a data-protection incident before it is an
engineering task. Involve whoever owns learner data, and plan the change as a migration with a
defined cut-over, not as a variable update. If you do proceed, keep the old secret: it is the only
way to interpret historical evidence.

---

## Learning record store credentials

`LRS_BEARER_TOKEN`, or `LRS_BASIC_USERNAME` / `LRS_BASIC_PASSWORD`. Rotating them is ordinary: set
the new value and roll the replicas. Delivery attempts made with a stale credential fail with 401,
which the forwarder treats as permanent and dead-letters — so after rotating, check for dead letters
and requeue them:

```sh
curl -s "https://runtime.lorb.example/api/v1/evidence/outbox?status=DEAD_LETTER" \
  -H "authorization: Bearer $ADMIN_TOKEN" | jq '.items[] | {outbox_id, statement_id, last_error}'

curl -X POST "https://runtime.lorb.example/api/v1/evidence/outbox/$OUTBOX_ID/replay" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' -d "{\"statement_id\":\"$STATEMENT_ID\"}"
```

Replaying is safe: the statement keeps its original UUID, which xAPI treats as the deduplication key,
so a statement that did arrive is not recorded twice.
