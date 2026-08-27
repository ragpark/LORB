/**
 * The learning record store against Postgres.
 *
 * The properties here do not exist without a database, and they are the ones that make this a record
 * rather than a cache: a statement survives a restart, cannot be edited or deleted once accepted —
 * enforced by a trigger, not by application code — and two replicas delivering the same statement at
 * the same moment produce one row rather than two.
 *
 * Needs Postgres. Without DATABASE_URL there is nothing here to check and the suite skips.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/lrs/src/db.js";
import { PostgresLrsStore } from "../../packages/lrs/src/store.js";
import { prepareStatement } from "../../packages/lrs/src/statement.js";
import { buildLrs, testConfig } from "../../packages/lrs/src/app.js";

const DATABASE_URL = process.env.LRS_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const TOKEN = "a-postgres-suite-bearer-token-value";

describeIfDatabase("learning record store on Postgres", () => {
  let pool: pg.Pool;
  let store: PostgresLrsStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await migrate(pool);
    store = new PostgresLrsStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const facetsFor = (overrides: Record<string, unknown> = {}, id = randomUUID()) => {
    const prepared = prepareStatement({
      actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: "e".repeat(64) } },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
      object: { id: "https://lorb.example/activities/ratios", objectType: "Activity" },
      timestamp: "2026-08-27T09:00:00.000Z",
      ...overrides,
    }, { addressedTo: id, requirePseudonymousActor: true });
    if (!prepared.ok) throw new Error(`unexpected: ${prepared.problem.code}`);
    return prepared.prepared.facets;
  };

  it("stores a statement and reads it back after a new connection", async () => {
    const facets = facetsFor();
    expect(await store.accept(facets)).toBe("STORED");

    const reopened = new PostgresLrsStore(new pg.Pool({ connectionString: DATABASE_URL }));
    try {
      const read = await reopened.get(facets.statement_id);
      expect(read?.statement_id).toBe(facets.statement_id);
      expect((read?.payload as { verb: { id: string } }).verb.id).toBe("http://adlnet.gov/expapi/verbs/completed");
    } finally {
      await reopened.close();
    }
  });

  it("refuses to modify or delete an accepted statement, at the database", async () => {
    const facets = facetsFor();
    await store.accept(facets);
    await expect(
      pool.query("update statement set payload = '{\"tampered\":true}'::jsonb where statement_id = $1", [facets.statement_id]),
    ).rejects.toThrow(/STATEMENT_IMMUTABLE/);
    await expect(
      pool.query("delete from statement where statement_id = $1", [facets.statement_id]),
    ).rejects.toThrow(/STATEMENT_IMMUTABLE/);
    expect(await store.get(facets.statement_id)).toBeDefined();
  });

  /**
   * The facets decide which statements a reader is shown and in what order, so a payload nobody can
   * edit is worth little if the row's answer to "whose statement is this?" can be edited instead.
   */
  it("freezes the query facets and the sequence too, not only the payload", async () => {
    const facets = facetsFor();
    await store.accept(facets);
    for (const [column, value] of [
      ["actor_pseudonym", "'someone-else'"],
      ["verb_id", "'http://adlnet.gov/expapi/verbs/launched'"],
      ["object_id", "'https://lorb.example/activities/other'"],
      ["seq", "seq + 1000"],
      ["stored_at", "now()"],
      ["timestamp", "now()"],
      ["payload_digest", "'0'"],
      ["repository_id", "gen_random_uuid()"],
      ["correlation_id", "'rewritten'"],
    ] as const) {
      await expect(
        pool.query(`update statement set ${column} = ${value} where statement_id = $1`, [facets.statement_id]),
        column,
      ).rejects.toThrow(/STATEMENT_IMMUTABLE/);
    }
    // Voiding is the one thing an update may do, because that is how xAPI retracts a statement.
    await expect(
      pool.query("update statement set voided = true, voided_at = now() where statement_id = $1", [facets.statement_id]),
    ).resolves.toBeDefined();
  });

  it("stores a whole batch or none of it", async () => {
    const taken = randomUUID();
    await store.accept(facetsFor({ result: { completion: true } }, taken));
    const before = await store.count();

    const conflicting = await store.acceptAll([
      facetsFor({ result: { completion: true } }),
      facetsFor({ result: { completion: false } }, taken),
      facetsFor({ result: { completion: true } }),
    ]);
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.conflictAt).toBe(1);
    // Nothing from the batch landed, including the entry that preceded the conflict.
    expect(await store.count()).toBe(before);

    const clean = await store.acceptAll([facetsFor(), facetsFor()]);
    expect(clean.ok).toBe(true);
    expect(await store.count()).toBe(before + 2);
  });

  it("recognises its own representation, and a batch that conflicts with itself", async () => {
    const id = randomUUID();
    const prepared = prepareStatement(
      { actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: "e".repeat(64) } },
        verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
        object: { id: "https://lorb.example/activities/ratios", objectType: "Activity" } },
      { addressedTo: id, requirePseudonymousActor: true },
    );
    if (!prepared.ok) throw new Error("unexpected");
    expect(await store.accept(prepared.prepared.facets)).toBe("STORED");

    // The representation this store serves carries a timestamp it assigned; sending it back is the
    // same statement, not a conflicting one.
    const representation = (await store.get(id))!.payload;
    const replay = prepareStatement(representation, { addressedTo: id, requirePseudonymousActor: true });
    if (!replay.ok) throw new Error("unexpected");
    expect(await store.accept(replay.prepared.facets)).toBe("DUPLICATE");

    // A batch disagreeing with itself is refused before anything in it is written.
    const before = await store.count();
    const clash = await store.acceptAll([facetsFor({ result: { completion: true } }, id), facetsFor({ result: { completion: false } }, id)]);
    expect(clash.ok).toBe(false);
    expect(await store.count()).toBe(before);
  });

  it("serves `stored` from the row rather than from the sender", async () => {
    const facets = facetsFor({ stored: "1999-01-01T00:00:00.000Z" });
    await store.accept(facets);
    const read = await store.get(facets.statement_id);
    expect((read?.payload as { stored?: string }).stored).toBe(read?.stored_at);
    expect((read?.payload as { stored?: string }).stored).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("stores one row when two replicas deliver the same statement at the same moment", async () => {
    const facets = facetsFor();
    const outcomes = await Promise.all([store.accept(facets), store.accept(facets), store.accept(facets)]);
    expect(outcomes.filter((outcome) => outcome === "STORED")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "DUPLICATE")).toHaveLength(2);
    const rows = await pool.query("select count(*)::int as count from statement where statement_id = $1", [facets.statement_id]);
    expect(rows.rows[0].count).toBe(1);
  });

  it("reports a different statement under a taken id as a conflict, and keeps the first", async () => {
    const id = randomUUID();
    await store.accept(facetsFor({ result: { completion: true } }, id));
    expect(await store.accept(facetsFor({ result: { completion: false } }, id))).toBe("CONFLICT");
    expect((await store.get(id))?.payload).toMatchObject({ result: { completion: true } });
  });

  it("queries by facet and pages in a stable order", async () => {
    const learner = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const actor = { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: learner } };
    for (let index = 0; index < 3; index += 1) await store.accept(facetsFor({ actor }));

    const first = await store.query({ agent: learner, limit: 2, ascending: true });
    expect(first.statements).toHaveLength(2);
    expect(first.next).toBeDefined();
    const second = await store.query({ agent: learner, limit: 2, ascending: true, after: first.next });
    expect(second.statements).toHaveLength(1);
    const ids = [...first.statements, ...second.statements].map((row) => row.statement_id);
    expect(new Set(ids).size).toBe(3);
  });

  it("hides a voided statement from queries however the two arrive", async () => {
    const app = (await buildLrs({ config: testConfig({ credentials: [{ kind: "bearer", token: TOKEN }] }), store })).app;
    const auth = { authorization: `Bearer ${TOKEN}` };
    const voidOf = (target: string) => ({
      actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: "e".repeat(64) } },
      verb: { id: "http://adlnet.gov/expapi/verbs/voided", display: { "en-GB": "voided" } },
      object: { objectType: "StatementRef", id: target },
      timestamp: "2026-08-27T09:05:00.000Z",
    });

    // Target first, then the void.
    const target = randomUUID();
    await store.accept(facetsFor({}, target));
    await app.inject({ method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth, payload: voidOf(target) });
    expect((await store.get(target))?.voided).toBe(true);

    // Void first, then the target it names — delivery order is not guaranteed.
    const late = randomUUID();
    await app.inject({ method: "PUT", url: `/statements?statementId=${randomUUID()}`, headers: auth, payload: voidOf(late) });
    await store.accept(facetsFor({}, late));
    expect((await store.get(late))?.voided).toBe(true);
    await app.close();
  });

  it("applies its migrations once, however many replicas start at the same time", async () => {
    const applied = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    expect(applied.every((count) => count === 0)).toBe(true);
  });
});
