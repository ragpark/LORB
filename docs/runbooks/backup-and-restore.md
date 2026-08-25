# Backup and restore

## What has to survive

Everything that matters is in one Postgres database. There is no local disk state, no in-memory
system of record, and nothing on a replica worth backing up.

| Table group | Loss means |
| --- | --- |
| `evidence_outbox` | Learner achievement that was accepted and not yet delivered is gone. Unrecoverable. |
| `attempt` | Learners lose in-progress work and completion records. |
| `learning_object`, `object_version`, `package_version`, `learning_object_content` | The catalogue. Republishable, but every descriptor that pinned a version now points at nothing. |
| `class`, `class_learner`, `class_assignment*` | Teachers lose their rosters and assignment history. |
| `audit_record` | The record of who did what. Append-only by trigger; losing it is a compliance problem, not just an operational one. |
| `repository_membership`, `player*`, `launch_policy*` | Administrative configuration. Rebuildable by hand, slowly. |
| `smart_link` | Shared links stop working. Recreatable, but every distributed URL is dead. |

The evidence outbox is the one with no second copy anywhere until the forwarder has delivered it, so
recovery-point objective should be set by how much evidence you are willing to lose, not by how long
the catalogue takes to rebuild.

## Recommended objectives

| Objective | Target | Why |
| --- | --- | --- |
| RPO | 5 minutes | Bounded by undelivered evidence. Continuous archiving (WAL) gets this; nightly dumps do not. |
| RTO | 1 hour | The service is stateless; recovery time is restore time plus a replica roll. |
| Retention | 35 days point-in-time, 12 months of monthly dumps | Long enough to notice a slow corruption; the audit trail's own retention is a separate decision. |

Use the managed provider's continuous backup where there is one. A nightly `pg_dump` alone means an
RPO of up to 24 hours of evidence, which is not an acceptable answer for learner achievement.

## Taking a manual backup

```sh
pg_dump --format=custom --no-owner --no-privileges \
        --file="lorb-$(date -u +%Y%m%dT%H%M%SZ).dump" "$DATABASE_URL"
```

Encrypt it at rest and store it away from the database's own account. A backup readable by the same
credential that could drop the database is not a backup.

## Restoring

1. **Stop writes.** Scale the Runtime API to zero replicas. Restoring underneath a running service
   produces a database that disagrees with the requests in flight.

2. **Restore into a new database**, never over the live one — the failed original is evidence about
   what went wrong, and you may need it.

   ```sh
   createdb lorb_restored
   pg_restore --dbname="$RESTORED_URL" --no-owner --no-privileges lorb-….dump
   ```

3. **Bring the schema forward.** A backup taken before the current release may predate a migration.

   ```sh
   DATABASE_URL="$RESTORED_URL" pnpm db:setup:production
   ```

4. **Check what you restored** before pointing anything at it:

   ```sh
   psql "$RESTORED_URL" -c "select count(*) from attempt"
   psql "$RESTORED_URL" -c "select status, count(*) from evidence_outbox group by status"
   psql "$RESTORED_URL" -c "select max(created_at) from audit_record"
   ```

   The last query tells you the real recovery point: the most recent administrative action the
   restored database knows about.

5. **Point `DATABASE_URL` at the restored database and scale back up.** Watch `/ready` until every
   replica reports `checks.store: "ok"`.

6. **Let the forwarder catch up.** Anything `PENDING` or `FAILED` in the restored outbox is delivered
   on the next passes. Watch `lorb_evidence_forwarded_total{outcome="delivered"}` climb and then
   flatten.

## What a restore cannot fix

- **Evidence accepted after the recovery point.** It was written to the outbox and the outbox is what
  you restored over. If it had already been forwarded, the learning record store still has it — that
  is the argument for keeping the forwarder healthy rather than letting a backlog build.
- **Descriptors issued before the restore.** They reference attempt rows that may no longer exist,
  and will fail with `ATTEMPT_CONFLICT`. They expire within `DESCRIPTOR_TTL_SECONDS` anyway.
- **Idempotency records.** A client retrying a launch across the restore point gets a second attempt
  rather than a replay. Harmless; it shows as an extra attempt row.

## Testing the restore

An untested backup is a belief, not a control. Quarterly:

1. Restore the most recent backup into a scratch database.
2. Run `pnpm db:setup:production` against it and confirm it reports no pending migrations.
3. Point a staging Runtime API at it, hit `/ready`, and drive one launch to completion.
4. Record the wall-clock time from starting the restore to a successful launch. That number is your
   real RTO; the target above is only a target until you have measured it.
