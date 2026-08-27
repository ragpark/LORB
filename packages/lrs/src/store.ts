/**
 * Where statements live.
 *
 * Two backends behind one interface, the same shape the rest of the platform uses: Postgres for a
 * deployment, in-process for `pnpm dev` and the suites. The interface is deliberately small — an LRS
 * writes once and reads by facet, and everything else is a query.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type { StatementFacets } from "./statement.js";

export type AcceptOutcome = "STORED" | "DUPLICATE" | "CONFLICT";

export interface StoredStatement {
  statement_id: string;
  /** This store's own recording order, and the exact key a page continues from. */
  seq: string;
  stored_at: string;
  timestamp: string;
  voided: boolean;
  payload: unknown;
}

export interface StatementQuery {
  statementId?: string;
  agent?: string;
  verb?: string;
  activity?: string;
  registration?: string;
  /** LORB facets. Not xAPI, and the two questions an operator actually asks of this store. */
  attemptId?: string;
  repositoryId?: string;
  since?: string;
  until?: string;
  limit: number;
  ascending: boolean;
  /** Opaque continuation: the sequence of the last row of the previous page. */
  after?: { seq: string };
  includeVoided?: boolean;
}

export interface StatementPage {
  statements: StoredStatement[];
  /** Set when more rows match than this page carries. */
  next?: { seq: string };
}

/**
 * The result of a batch. Either every statement in it was written, or none was: a batch that is
 * half-stored and then rejected leaves the sender unable to tell which half landed, and — for
 * statements it did not supply ids for — with no way to reach the ones that did.
 */
export type BatchResult = { ok: true; outcomes: AcceptOutcome[] } | { ok: false; conflictAt: number };

export interface LrsStore {
  readonly kind: "postgres" | "memory";
  ping(): Promise<void>;
  close(): Promise<void>;
  /** Writes one statement, applying xAPI's dedupe-by-id rule. */
  accept(facets: StatementFacets): Promise<AcceptOutcome>;
  /** Writes a batch atomically: a conflict anywhere in it stores none of it. */
  acceptAll(facets: StatementFacets[]): Promise<BatchResult>;
  get(statementId: string): Promise<StoredStatement | undefined>;
  query(query: StatementQuery): Promise<StatementPage>;
  count(): Promise<number>;
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const matchesUuid = (value: string | null): string | null =>
  value && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value) ? value : null;

export class MemoryLrsStore implements LrsStore {
  readonly kind = "memory" as const;
  private readonly statements = new Map<string, StoredStatement & { digest: string; facets: StatementFacets }>();
  private readonly voidsPending = new Map<string, string>();
  private sequence = 0;

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async acceptAll(facets: StatementFacets[]): Promise<BatchResult> {
    // Checked in full before anything is written, so the all-or-nothing promise holds here too.
    for (const [index, entry] of facets.entries()) {
      const existing = this.statements.get(entry.statement_id);
      if (existing && existing.digest !== entry.digest) return { ok: false, conflictAt: index };
    }
    const outcomes: AcceptOutcome[] = [];
    for (const entry of facets) outcomes.push(await this.accept(entry));
    return { ok: true, outcomes };
  }

  async accept(facets: StatementFacets): Promise<AcceptOutcome> {
    const existing = this.statements.get(facets.statement_id);
    if (existing) return existing.digest === facets.digest ? "DUPLICATE" : "CONFLICT";
    this.sequence += 1;
    this.statements.set(facets.statement_id, {
      statement_id: facets.statement_id,
      seq: String(this.sequence),
      stored_at: new Date().toISOString(),
      timestamp: facets.timestamp,
      voided: this.voidsPending.has(facets.statement_id),
      payload: facets.payload,
      digest: facets.digest,
      facets,
    });
    if (facets.voids) {
      this.voidsPending.set(facets.voids, facets.statement_id);
      const target = this.statements.get(facets.voids);
      if (target) target.voided = true;
    }
    return "STORED";
  }

  async get(statementId: string): Promise<StoredStatement | undefined> {
    const row = this.statements.get(statementId.toLowerCase());
    return row ? withStored(row) : undefined;
  }

  async query(query: StatementQuery): Promise<StatementPage> {
    let rows = [...this.statements.values()]
      .filter((row) => query.includeVoided || !row.voided)
      .filter((row) => !query.agent || row.facets.actor_pseudonym === query.agent)
      .filter((row) => !query.verb || row.facets.verb_id === query.verb)
      .filter((row) => !query.activity || row.facets.object_id === query.activity)
      .filter((row) => !query.registration || row.facets.registration === query.registration)
      .filter((row) => !query.attemptId || row.facets.attempt_id === query.attemptId)
      .filter((row) => !query.repositoryId || row.facets.repository_id === query.repositoryId)
      .filter((row) => !query.since || row.stored_at > query.since)
      .filter((row) => !query.until || row.stored_at <= query.until);

    rows.sort((a, b) => (query.ascending ? Number(a.seq) - Number(b.seq) : Number(b.seq) - Number(a.seq)));
    if (query.after) {
      const cursor = Number(query.after.seq);
      rows = rows.filter((row) => (query.ascending ? Number(row.seq) > cursor : Number(row.seq) < cursor));
    }
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      statements: page.map(withStored),
      next: rows.length > query.limit && last ? { seq: last.seq } : undefined,
    };
  }

  async count(): Promise<number> {
    return this.statements.size;
  }

  reset(): void {
    this.statements.clear();
    this.voidsPending.clear();
  }
}

export class PostgresLrsStore implements LrsStore {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * One transaction, and the insert is the concurrency control: two replicas delivered the same
   * statement at the same moment both reach `on conflict do nothing`, and exactly one of them
   * inserted. The loser then reads the row and compares digests, which is the same answer it would
   * have got a millisecond earlier.
   */
  async accept(facets: StatementFacets): Promise<AcceptOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const outcome = await acceptWithin(client, facets);
      await client.query("commit");
      return outcome;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A batch in one transaction. A conflict anywhere rolls the whole thing back, so the ids answered
   * to the caller are exactly the statements that are now stored — and a retry of a rejected batch
   * cannot leave a first attempt's generated ids stranded and unreachable.
   */
  async acceptAll(facets: StatementFacets[]): Promise<BatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const outcomes: AcceptOutcome[] = [];
      for (const [index, entry] of facets.entries()) {
        const outcome = await acceptWithin(client, entry);
        if (outcome === "CONFLICT") {
          await client.query("rollback");
          return { ok: false, conflictAt: index };
        }
        outcomes.push(outcome);
      }
      await client.query("commit");
      return { ok: true, outcomes };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(statementId: string): Promise<StoredStatement | undefined> {
    const result = await this.pool.query(
      "select statement_id, seq, stored_at, timestamp, voided, payload from statement where statement_id = $1",
      [statementId.toLowerCase()],
    );
    const row = result.rows[0];
    return row ? withStored({ ...row, seq: String(row.seq), stored_at: iso(row.stored_at), timestamp: iso(row.timestamp) }) : undefined;
  }

  async query(query: StatementQuery): Promise<StatementPage> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("$?", `$${values.length}`));
    };
    if (!query.includeVoided) clauses.push("voided = false");
    if (query.agent) add("actor_pseudonym = $?", query.agent);
    if (query.verb) add("verb_id = $?", query.verb);
    if (query.activity) add("object_id = $?", query.activity);
    if (query.registration) add("registration = $?", query.registration);
    if (query.attemptId) add("attempt_id = $?", query.attemptId);
    if (query.repositoryId) add("repository_id = $?", query.repositoryId);
    if (query.since) add("stored_at > $?", query.since);
    if (query.until) add("stored_at <= $?", query.until);
    if (query.after) {
      values.push(query.after.seq);
      clauses.push(query.ascending ? `seq > $${values.length}` : `seq < $${values.length}`);
    }
    const direction = query.ascending ? "asc" : "desc";
    values.push(query.limit + 1);
    const result = await this.pool.query(
      `select statement_id, seq, stored_at, timestamp, voided, payload from statement
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by seq ${direction} limit $${values.length}`,
      values,
    );
    const rows = result.rows
      .map((row) => ({ ...row, seq: String(row.seq), stored_at: iso(row.stored_at), timestamp: iso(row.timestamp) }))
      .map(withStored);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      statements: page,
      next: rows.length > query.limit && last ? { seq: last.seq } : undefined,
    };
  }

  async count(): Promise<number> {
    return Number((await this.pool.query("select count(*)::int as count from statement")).rows[0].count);
  }
}

/**
 * Puts this store's own `stored` on the way out.
 *
 * xAPI reserves `stored` for the learning record store to assign, and the column is the authority.
 * Serving it from the row means a statement that arrived without one is not returned without
 * provenance, and one that arrived carrying somebody's guess does not keep it.
 */
function withStored(row: StoredStatement): StoredStatement {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? { ...(row.payload as Record<string, unknown>), stored: row.stored_at }
    : row.payload;
  return { statement_id: row.statement_id, seq: row.seq, stored_at: row.stored_at, timestamp: row.timestamp, voided: row.voided, payload };
}

/**
 * Writes one statement on a caller's transaction, so a batch can share one.
 *
 * The insert is the concurrency control: two replicas delivered the same statement at the same
 * moment both reach `on conflict do nothing`, and exactly one of them inserted. The loser reads the
 * row and compares digests, which is the answer it would have got a millisecond earlier.
 */
async function acceptWithin(client: pg.PoolClient, facets: StatementFacets): Promise<AcceptOutcome> {
  const inserted = await client.query(
    `insert into statement (statement_id, timestamp, actor_pseudonym, verb_id, object_id, registration,
       repository_id, attempt_id, package_version_id, correlation_id, payload_digest, payload,
       voided, voided_by, voided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       exists (select 1 from statement_void where voided_statement_id = $1),
       (select voiding_statement_id from statement_void where voided_statement_id = $1 limit 1),
       case when exists (select 1 from statement_void where voided_statement_id = $1) then now() end)
     on conflict (statement_id) do nothing
     returning statement_id`,
    [
      facets.statement_id, facets.timestamp, facets.actor_pseudonym, facets.verb_id, facets.object_id,
      matchesUuid(facets.registration), matchesUuid(facets.repository_id), matchesUuid(facets.attempt_id),
      matchesUuid(facets.package_version_id), facets.correlation_id, facets.digest, JSON.stringify(facets.payload),
    ],
  );

  if (inserted.rowCount === 0) {
    const existing = await client.query("select payload_digest from statement where statement_id = $1", [facets.statement_id]);
    return existing.rows[0]?.payload_digest === facets.digest ? "DUPLICATE" : "CONFLICT";
  }

  if (facets.voids) {
    await client.query(
      "insert into statement_void (voiding_statement_id, voided_statement_id) values ($1,$2) on conflict do nothing",
      [facets.statement_id, facets.voids],
    );
    // Applied where the target is already here; where it is not, the insert above applies it when the
    // target arrives. Delivery order is not guaranteed, so both directions have to work.
    await client.query(
      "update statement set voided = true, voided_at = now(), voided_by = $2 where statement_id = $1 and voided = false",
      [facets.voids, facets.statement_id],
    );
  }
  return "STORED";
}

/** A short, opaque continuation token. Its contents are this store's business, not the caller's. */
export function encodeCursor(next: { seq: string }): string {
  return Buffer.from(`s:${next.seq}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { seq: string } | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const seq = decoded.startsWith("s:") ? decoded.slice(2) : undefined;
    return seq && /^\d+$/.test(seq) ? { seq } : undefined;
  } catch {
    return undefined;
  }
}

/** Stable identity for a credential in logs and metrics, without ever writing the credential down. */
export function credentialLabel(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
