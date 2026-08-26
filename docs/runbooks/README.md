# Runbooks

Operational procedures for running LORB. Each one is written to be followed under pressure by
somebody who did not write the code, so they name exact commands and exact expected output.

| Runbook | Use it when |
| --- | --- |
| [deployment.md](deployment.md) | Deploying a new version, or standing an environment up from nothing. |
| [auth0-provisioning.md](auth0-provisioning.md) | Rebuilding the Auth0 tenant, or moving a surface onto the identity provider. |
| [key-rotation.md](key-rotation.md) | Rotating the descriptor signing key or the pseudonym secret. |
| [backup-and-restore.md](backup-and-restore.md) | Taking backups, testing them, and restoring after data loss. |
| [incident-response.md](incident-response.md) | Launches failing, evidence not arriving, a replica unhealthy. |
| [observability.md](observability.md) | Working out what is happening: metrics, logs, correlation. |

## The five things to know before touching production

1. **The database is the system of record.** Attempts, evidence, the catalogue, idempotency records
   and smart links all live in Postgres. A replica holds nothing that matters; losing one costs the
   requests in flight and nothing else.

2. **The descriptor signing key is shared, not per replica.** It comes from configuration. Changing
   it without an overlap window invalidates every descriptor currently in a learner's browser. See
   [key-rotation.md](key-rotation.md).

3. **Accepted evidence is never lost, and never rewritten.** The Evidence API writes to a durable
   outbox before answering; the forwarder retries with backoff and dead-letters rather than
   discarding. A database trigger refuses any update to an accepted statement's payload and refuses
   deletes outright. If evidence is missing downstream, it is in the outbox — go and look.

4. **A production process refuses to start when it is misconfigured.** No database, no signing key,
   no pseudonym secret, no identity provider, no learning-record-store credentials, an empty CORS
   allow-list, the development identity provider, or example content: each of those fails start-up
   with every problem named at once. A crash-looping replica after a configuration change is almost
   always this — read the `refusing to start: invalid configuration` line.

5. **The pseudonym secret is not rotatable in the ordinary sense.** It keys the function that turns a
   learner identifier into the actor on every attempt and every xAPI statement. Change it and all
   historical evidence stops resolving to the same person. See [key-rotation.md](key-rotation.md)
   before considering it.
