/**
 * Postgres implementation of the runtime store: the system of record for every deployed environment.
 *
 * Three behaviours here are the point of the whole module, and none of them was expressible while
 * state lived in a process:
 *
 *   - Attempt state is written under optimistic concurrency in a single statement, so two replicas
 *     racing on the same attempt cannot both win.
 *   - Idempotency records outlive the process, so a client retrying a launch after a deploy gets the
 *     original response rather than a second attempt.
 *   - Evidence rows are claimed with `for update skip locked`, so every replica can run the
 *     forwarder and no statement is delivered twice.
 */
import pg from "pg";
import { isLegalTransition, OPEN_STATUSES, TERMINAL_STATUSES } from "./transitions.js";
import type {
  Assignment, Attempt, AttemptFilter, IdempotentClaim, IdempotentReplay, LaunchRecord, OutboxRow, OutboxStatus,
  RuntimeStore, SmartLink, StateWriteResult,
} from "./types.js";

const ATTEMPT_COLUMNS = `attempt_id, repository_id, object_id, object_version_id, package_version_id,
  pseudonymous_subject_id, consumer_id, status, revision, state_payload, correlation_id, created_at,
  started_at, completed_at, terminated_at, expires_at, governed_by_launch_policy,
  package_pinned_by_object, source`;

const OUTBOX_COLUMNS = `outbox_id, statement_id, repository_id, attempt_id, package_version_id, object_id,
  actor_pseudonym, verb_id, payload, status, attempts, last_error, created_at, forwarded_at,
  next_attempt_at, dead_lettered_at, correlation_id`;

const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

function toAttempt(row: Record<string, any>): Attempt {
  return {
    attempt_id: row.attempt_id,
    repository_id: row.repository_id,
    object_id: row.object_id,
    object_version_id: row.object_version_id,
    package_version_id: row.package_version_id,
    pseudonym: row.pseudonymous_subject_id,
    consumer_id: row.consumer_id,
    status: row.status,
    revision: row.revision,
    state: row.state_payload ?? undefined,
    correlation_id: row.correlation_id,
    created_at: iso(row.created_at)!,
    started_at: iso(row.started_at),
    completed_at: iso(row.completed_at),
    terminated_at: iso(row.terminated_at),
    expires_at: iso(row.expires_at),
    governed_by_launch_policy: row.governed_by_launch_policy ?? undefined,
    package_pinned_by_object: row.package_pinned_by_object === true ? true : undefined,
    source: row.source,
  };
}

function toOutbox(row: Record<string, any>): OutboxRow {
  return {
    outbox_id: row.outbox_id,
    statement_id: row.statement_id,
    repository_id: row.repository_id,
    attempt_id: row.attempt_id ?? null,
    package_version_id: row.package_version_id,
    object_id: row.object_id ?? null,
    actor_pseudonym: row.actor_pseudonym ?? null,
    verb_id: row.verb_id ?? null,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error ?? null,
    created_at: iso(row.created_at)!,
    forwarded_at: iso(row.forwarded_at),
    next_attempt_at: iso(row.next_attempt_at)!,
    dead_lettered_at: iso(row.dead_lettered_at),
    correlation_id: row.correlation_id,
  };
}

function toSmartLink(row: Record<string, any>): SmartLink {
  return {
    smart_link_id: row.smart_link_id,
    object_id: row.object_id,
    token_prefix: row.token_prefix,
    created_by_pseudonym: row.created_by_pseudonym,
    created_at: iso(row.created_at)!,
    revoked_at: iso(row.revoked_at),
    last_redeemed_at: iso(row.last_redeemed_at),
    redemption_count: Number(row.redemption_count ?? 0),
  };
}

export class PostgresRuntimeStore implements RuntimeStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createAttempt(attempt: Attempt): Promise<void> {
    await this.pool.query(
      `insert into attempt (attempt_id, repository_id, object_id, object_version_id, package_version_id,
         pseudonymous_subject_id, consumer_id, status, revision, state_payload, correlation_id,
         created_at, started_at, expires_at, governed_by_launch_policy, package_pinned_by_object, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()), $13, $14, $15, $16, $17)
       on conflict (attempt_id) do nothing`,
      [
        attempt.attempt_id, attempt.repository_id, attempt.object_id, attempt.object_version_id,
        attempt.package_version_id, attempt.pseudonym, attempt.consumer_id, attempt.status,
        attempt.revision, attempt.state === undefined ? null : JSON.stringify(attempt.state),
        attempt.correlation_id, attempt.created_at ?? null, attempt.started_at ?? null,
        attempt.expires_at ?? null,
        attempt.governed_by_launch_policy ? JSON.stringify(attempt.governed_by_launch_policy) : null,
        attempt.package_pinned_by_object === true, attempt.source,
      ],
    );
  }

  async getAttempt(attemptId: string): Promise<Attempt | undefined> {
    const result = await this.pool.query(`select ${ATTEMPT_COLUMNS} from attempt where attempt_id = $1`, [attemptId]);
    return result.rows[0] ? toAttempt(result.rows[0]) : undefined;
  }

  async listAttempts(filter: AttemptFilter): Promise<Attempt[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    if (filter.repository_id) add("repository_id = ?", filter.repository_id);
    if (filter.object_id) add("object_id = ?", filter.object_id);
    if (filter.pseudonym) add("pseudonymous_subject_id = ?", filter.pseudonym);
    if (filter.status) add("status = ?", filter.status);
    values.push(Math.min(filter.limit ?? 200, 1000));
    const result = await this.pool.query(
      `select ${ATTEMPT_COLUMNS} from attempt
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by created_at desc limit $${values.length}`,
      values,
    );
    return result.rows.map(toAttempt);
  }

  /**
   * The revision check is in the `where` clause rather than a read followed by a write: a
   * read-then-write leaves a window in which another replica bumps the revision between the two, and
   * both writers believe they applied cleanly.
   */
  async writeAttemptState(attemptId: string, expectedRevision: number, state: unknown): Promise<StateWriteResult> {
    const result = await this.pool.query(
      `update attempt set
         state_payload = $3,
         revision = revision + 1,
         status = case when status = 'CREATED' then 'STARTED' when status = 'SUSPENDED' then 'RESUMED' else status end,
         started_at = coalesce(started_at, now()),
         updated_at = now()
       where attempt_id = $1 and revision = $2 and status = any($4::text[])
       returning revision, status`,
      [attemptId, expectedRevision, JSON.stringify(state), OPEN_STATUSES],
    );
    if (result.rowCount) return { outcome: "APPLIED", revision: result.rows[0].revision, status: result.rows[0].status };
    const exists = await this.pool.query("select 1 from attempt where attempt_id = $1", [attemptId]);
    return exists.rowCount ? { outcome: "CONFLICT" } : { outcome: "NOT_FOUND" };
  }

  async transitionAttempt(attemptId: string, next: Attempt["status"]): Promise<StateWriteResult> {
    const current = await this.pool.query("select status from attempt where attempt_id = $1", [attemptId]);
    if (!current.rowCount) return { outcome: "NOT_FOUND" };
    if (!isLegalTransition(current.rows[0].status, next)) return { outcome: "CONFLICT" };
    // The legal source states are named again in the update so a concurrent transition that landed
    // between the read above and this write loses rather than being applied twice.
    const legalFrom = (["CREATED", "STARTED", "SUSPENDED", "RESUMED"] as const).filter((from) => isLegalTransition(from, next));
    const result = await this.pool.query(
      `update attempt set
         status = $2,
         completed_at = case when $2 = 'COMPLETED' then now() else completed_at end,
         terminated_at = case when $2 in ('ABANDONED','EXPIRED','VOIDED') then now() else terminated_at end,
         started_at = case when $2 = 'STARTED' then coalesce(started_at, now()) else started_at end,
         updated_at = now()
       where attempt_id = $1 and status = any($3::text[])
       returning revision, status`,
      [attemptId, next, legalFrom],
    );
    if (!result.rowCount) return { outcome: "CONFLICT" };
    return { outcome: "APPLIED", revision: result.rows[0].revision, status: result.rows[0].status };
  }

  async expireStaleAttempts(now = new Date()): Promise<number> {
    const result = await this.pool.query(
      `update attempt set status = 'EXPIRED', terminated_at = $1, updated_at = now()
       where status = any($2::text[]) and expires_at is not null and expires_at <= $1`,
      [now.toISOString(), OPEN_STATUSES],
    );
    return result.rowCount ?? 0;
  }

  async recordLaunch(launch: LaunchRecord): Promise<void> {
    await this.pool.query(
      `insert into launch (launch_id, attempt_id, repository_id, object_id, consumer_id, launch_mode, expires_at, correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (launch_id) do nothing`,
      [launch.launch_id, launch.attempt_id, launch.repository_id, launch.object_id, launch.consumer_id,
       launch.launch_mode, launch.expires_at, launch.correlation_id],
    );
  }

  async replayIdempotent(scope: string, key: string, fingerprint: string): Promise<IdempotentReplay | undefined> {
    const result = await this.pool.query(
      `select request_fingerprint, status_code, response from idempotency_record
       where scope = $1 and idempotency_key = $2 and expires_at > now()`,
      [scope, key],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return { status_code: row.status_code, response: row.response, mismatch: row.request_fingerprint !== fingerprint };
  }

  async recordIdempotent(scope: string, key: string, fingerprint: string, statusCode: number, response: unknown, ttlMs: number): Promise<void> {
    await this.pool.query(
      `insert into idempotency_record (scope, idempotency_key, request_fingerprint, response, status_code, expires_at)
       values ($1,$2,$3,$4,$5, now() + ($6::bigint * interval '1 millisecond'))
       on conflict (scope, idempotency_key) do nothing`,
      [scope, key, fingerprint, JSON.stringify(response), statusCode, Math.round(ttlMs)],
    );
  }

  async claimIdempotent(scope: string, key: string, fingerprint: string, ttlMs: number): Promise<IdempotentClaim> {
    // One statement, so the claim is atomic across replicas. An expired row is taken over rather
    // than replayed: its response is past its useful life and the key is free again.
    const claimed = await this.pool.query(
      `insert into idempotency_record (scope, idempotency_key, request_fingerprint, expires_at)
       values ($1,$2,$3, now() + ($4::bigint * interval '1 millisecond'))
       on conflict (scope, idempotency_key) do update
         set request_fingerprint = excluded.request_fingerprint,
             response = null,
             status_code = null,
             claimed_at = now(),
             expires_at = excluded.expires_at
       where idempotency_record.expires_at <= now()
       returning scope`,
      [scope, key, fingerprint, Math.round(ttlMs)],
    );
    if (claimed.rowCount) return { state: "reserved" };

    const existing = await this.pool.query(
      `select request_fingerprint, status_code, response from idempotency_record
       where scope = $1 and idempotency_key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    // Gone between the two statements — expired and purged. The caller retrying is the right answer.
    if (!row) return { state: "in_flight" };
    if (row.request_fingerprint !== fingerprint) return { state: "mismatch" };
    if (row.status_code === null) return { state: "in_flight" };
    return { state: "replay", status_code: row.status_code, response: row.response };
  }

  async completeIdempotent(scope: string, key: string, statusCode: number, response: unknown): Promise<void> {
    await this.pool.query(
      `update idempotency_record set status_code = $3, response = $4
       where scope = $1 and idempotency_key = $2 and status_code is null`,
      [scope, key, statusCode, JSON.stringify(response)],
    );
  }

  async releaseIdempotent(scope: string, key: string): Promise<void> {
    await this.pool.query(
      "delete from idempotency_record where scope = $1 and idempotency_key = $2 and status_code is null",
      [scope, key],
    );
  }

  async purgeExpiredIdempotency(now = new Date()): Promise<number> {
    const result = await this.pool.query("delete from idempotency_record where expires_at <= $1", [now.toISOString()]);
    return result.rowCount ?? 0;
  }

  async enqueueStatement(row: Parameters<RuntimeStore["enqueueStatement"]>[0]): Promise<boolean> {
    const result = await this.pool.query(
      `insert into evidence_outbox (outbox_id, statement_id, repository_id, attempt_id, package_version_id,
         object_id, actor_pseudonym, verb_id, payload, status, attempts, next_attempt_at, correlation_id,
         statement_timestamp)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',0, now(), $10, $11)
       on conflict (statement_id) do nothing
       returning outbox_id`,
      [row.outbox_id, row.statement_id, row.repository_id, row.attempt_id, row.package_version_id,
       row.object_id, row.actor_pseudonym, row.verb_id, JSON.stringify(row.payload), row.correlation_id,
       (row.payload as { timestamp?: string } | undefined)?.timestamp ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listOutbox(filter: { status?: OutboxStatus; object_id?: string; limit?: number }): Promise<OutboxRow[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.status) { values.push(filter.status); clauses.push(`status = $${values.length}`); }
    if (filter.object_id) { values.push(filter.object_id); clauses.push(`object_id = $${values.length}`); }
    values.push(Math.min(filter.limit ?? 500, 2000));
    const result = await this.pool.query(
      `select ${OUTBOX_COLUMNS} from evidence_outbox
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by created_at desc limit $${values.length}`,
      values,
    );
    return result.rows.map(toOutbox);
  }

  async getOutbox(outboxId: string): Promise<OutboxRow | undefined> {
    const result = await this.pool.query(`select ${OUTBOX_COLUMNS} from evidence_outbox where outbox_id = $1`, [outboxId]);
    return result.rows[0] ? toOutbox(result.rows[0]) : undefined;
  }

  async getOutboxByStatement(statementId: string): Promise<OutboxRow | undefined> {
    const result = await this.pool.query(`select ${OUTBOX_COLUMNS} from evidence_outbox where statement_id = $1`, [statementId]);
    return result.rows[0] ? toOutbox(result.rows[0]) : undefined;
  }

  async requeueStatement(outboxId: string, statementId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update evidence_outbox set status = 'PENDING', next_attempt_at = now(), dead_lettered_at = null
       where outbox_id = $1 and statement_id = $2 and status in ('FAILED','DEAD_LETTER')`,
      [outboxId, statementId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * `skip locked` is what lets every replica run a forwarder: a row another worker already holds is
   * passed over instead of blocking, so throughput scales with replicas and no statement is claimed
   * twice. Rows left IN_FLIGHT by a worker that died are reclaimed after a stall window.
   */
  /**
   * `now` exists for tests that drive the clock. Left unset — which is how a forwarder normally calls
   * this — the database decides what is due, and that is deliberate rather than incidental.
   *
   * A row's `next_attempt_at` is written by Postgres at microsecond precision, and a JavaScript Date
   * carries milliseconds. Comparing the two means a statement enqueued and claimed within the same
   * millisecond can be a fraction of a millisecond in the future and get skipped, and across replicas
   * it means each one decides what is due by its own clock. Neither loses evidence — the next poll
   * picks the row up — but a queue whose notion of "now" comes from its clients is a queue that
   * behaves differently depending on which client asked.
   */
  async claimDueStatements(worker: string, limit: number, now?: Date): Promise<OutboxRow[]> {
    const result = await this.pool.query(
      `with moment as (select coalesce($1::timestamptz, now()) as at),
       due as (
         select outbox_id from evidence_outbox, moment
         where (status in ('PENDING','FAILED') and next_attempt_at <= moment.at)
            or (status = 'IN_FLIGHT' and claimed_at < moment.at - interval '5 minutes')
         order by next_attempt_at asc
         limit $2
         for update skip locked
       )
       update evidence_outbox set status = 'IN_FLIGHT', attempts = attempts + 1,
         claimed_at = (select at from moment), claimed_by = $3
       where outbox_id in (select outbox_id from due)
       returning ${OUTBOX_COLUMNS}`,
      [now?.toISOString() ?? null, limit, worker],
    );
    return result.rows.map(toOutbox);
  }

  async markForwarded(outboxId: string): Promise<void> {
    await this.pool.query(
      `update evidence_outbox set status = 'FORWARDED', forwarded_at = now(), last_error = null, claimed_by = null
       where outbox_id = $1`,
      [outboxId],
    );
  }

  async markDeliveryFailed(outboxId: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void> {
    await this.pool.query(
      `update evidence_outbox set
         status = $4, last_error = $2, next_attempt_at = $3, claimed_by = null,
         dead_lettered_at = case when $4 = 'DEAD_LETTER' then now() else dead_lettered_at end
       where outbox_id = $1`,
      [outboxId, error.slice(0, 2000), nextAttemptAt.toISOString(), deadLetter ? "DEAD_LETTER" : "FAILED"],
    );
  }

  async statementsForObject(objectId: string, since?: string): Promise<OutboxRow[]> {
    const result = await this.pool.query(
      `select ${OUTBOX_COLUMNS} from evidence_outbox
       where object_id = $1 and ($2::timestamptz is null or created_at >= $2::timestamptz)
       order by created_at asc`,
      [objectId.toLowerCase(), since ?? null],
    );
    return result.rows.map(toOutbox);
  }

  async recordAssignment(assignment: Assignment): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into assignment (assignment_id, object_id, source, created_by_pseudonym, created_at)
         values ($1,$2,$3,$4, coalesce($5::timestamptz, now())) on conflict (assignment_id) do nothing`,
        [assignment.assignment_id, assignment.object_id, assignment.source, assignment.created_by_pseudonym ?? null, assignment.created_at ?? null],
      );
      if (assignment.pseudonyms.length > 0) {
        await client.query(
          `insert into assignment_actor (assignment_id, pseudonym)
           select $1, unnest($2::text[]) on conflict do nothing`,
          [assignment.assignment_id, assignment.pseudonyms],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async assignmentsForObject(objectId: string): Promise<Assignment[]> {
    const result = await this.pool.query(
      `select a.assignment_id, a.object_id, a.source, a.created_by_pseudonym, a.created_at,
              coalesce(array_agg(l.pseudonym) filter (where l.pseudonym is not null), '{}') as pseudonyms
       from assignment a left join assignment_actor l on l.assignment_id = a.assignment_id
       where lower(a.object_id::text) = $1
       group by a.assignment_id order by a.created_at asc`,
      [objectId.toLowerCase()],
    );
    return result.rows.map((row) => ({
      assignment_id: row.assignment_id,
      object_id: row.object_id,
      source: row.source,
      created_by_pseudonym: row.created_by_pseudonym,
      created_at: iso(row.created_at)!,
      pseudonyms: row.pseudonyms ?? [],
    }));
  }

  async createSmartLink(link: SmartLink & { token_hash: string }): Promise<void> {
    await this.pool.query(
      `insert into smart_link (smart_link_id, object_id, token_hash, token_prefix, created_by_pseudonym, created_at)
       values ($1,$2,$3,$4,$5, coalesce($6::timestamptz, now()))`,
      [link.smart_link_id, link.object_id, link.token_hash, link.token_prefix, link.created_by_pseudonym, link.created_at ?? null],
    );
  }

  async smartLinkByTokenHash(tokenHash: string): Promise<SmartLink | undefined> {
    const result = await this.pool.query("select * from smart_link where token_hash = $1 and revoked_at is null", [tokenHash]);
    return result.rows[0] ? toSmartLink(result.rows[0]) : undefined;
  }

  async activeSmartLinkForObject(objectId: string): Promise<SmartLink | undefined> {
    const result = await this.pool.query("select * from smart_link where object_id = $1 and revoked_at is null", [objectId]);
    return result.rows[0] ? toSmartLink(result.rows[0]) : undefined;
  }

  async revokeSmartLink(objectId: string, revokedByPseudonym: string): Promise<SmartLink | undefined> {
    const result = await this.pool.query(
      `update smart_link set revoked_at = now(), revoked_by_pseudonym = $2
       where object_id = $1 and revoked_at is null returning *`,
      [objectId, revokedByPseudonym],
    );
    return result.rows[0] ? toSmartLink(result.rows[0]) : undefined;
  }

  async recordSmartLinkRedemption(smartLinkId: string): Promise<void> {
    await this.pool.query(
      "update smart_link set last_redeemed_at = now(), redemption_count = redemption_count + 1 where smart_link_id = $1",
      [smartLinkId],
    );
  }

  async recordHeartbeat(worker: string, instance: string, detail?: unknown): Promise<void> {
    await this.pool.query(
      `insert into worker_heartbeat (worker, instance, last_seen_at, detail) values ($1,$2, now(), $3)
       on conflict (worker) do update set instance = excluded.instance, last_seen_at = now(), detail = excluded.detail`,
      [worker, instance, detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  async heartbeats(): Promise<{ worker: string; instance: string; last_seen_at: string; detail: unknown }[]> {
    const result = await this.pool.query("select worker, instance, last_seen_at, detail from worker_heartbeat");
    return result.rows.map((row) => ({ worker: row.worker, instance: row.instance, last_seen_at: iso(row.last_seen_at)!, detail: row.detail }));
  }
}

export { TERMINAL_STATUSES };
