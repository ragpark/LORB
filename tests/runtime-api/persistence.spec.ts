/**
 * The Postgres store, exercised against a real database.
 *
 * These are the properties the in-memory implementation cannot demonstrate and that the previous
 * design could not have: state survives the process, two writers racing on one attempt produce one
 * winner, an idempotency key replays across a restart, and two forwarder replicas never claim the
 * same statement.
 *
 * The suite skips itself when DATABASE_URL is unset, so a contributor without a database still gets
 * a green run — but continuous integration runs a Postgres service container, so it does execute.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresRuntimeStore } from "../../packages/runtime-api/src/store/postgres.js";
import { PostgresCatalogueStore } from "../../packages/runtime-api/src/catalogue/postgres.js";
import type { Attempt } from "../../packages/runtime-api/src/store/types.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;

describeIfDatabase("Postgres runtime store", () => {
  let pool: pg.Pool;
  let store: PostgresRuntimeStore;
  let catalogue: PostgresCatalogueStore;
  let repositoryId: string;
  let objectId: string;
  let objectVersionId: string;
  let packageVersionId: string;

  const attemptFor = (overrides: Partial<Attempt> = {}): Attempt => ({
    attempt_id: randomUUID(),
    repository_id: repositoryId,
    object_id: objectId,
    object_version_id: objectVersionId,
    package_version_id: packageVersionId,
    pseudonym: "a".repeat(64),
    consumer_id: "persistence-suite",
    status: "CREATED",
    revision: 1,
    correlation_id: randomUUID(),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
    source: "consumer",
    ...overrides,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresRuntimeStore(pool);
    catalogue = new PostgresCatalogueStore(pool);
    repositoryId = randomUUID();
    await pool.query(
      "insert into repository (repository_id, slug, display_name, status) values ($1,$2,$3,'ACTIVE')",
      [repositoryId, `persistence-${repositoryId.slice(0, 8)}`, "Persistence suite"],
    );
    const object = await catalogue.registerObject({
      repository_id: repositoryId, title: "Persistence target",
      module_path: "/module/index.html", semver: "1.0.0", sha256: "c".repeat(64),
    });
    objectId = object.object_id;
    objectVersionId = object.active_object_version_id;
    packageVersionId = object.active_package_version_id;
  });

  afterAll(async () => {
    await pool.query("delete from learning_object where repository_id = $1", [repositoryId]).catch(() => undefined);
    await pool.query("delete from repository where repository_id = $1", [repositoryId]).catch(() => undefined);
    await pool.end();
  });

  it("round-trips an attempt through a fresh store instance", async () => {
    const attempt = attemptFor();
    await store.createAttempt(attempt);

    // A different store object, as a second replica or a restarted process would be.
    const other = new PostgresRuntimeStore(pool);
    const read = await other.getAttempt(attempt.attempt_id);
    expect(read?.pseudonym).toBe(attempt.pseudonym);
    expect(read?.object_version_id).toBe(objectVersionId);
    expect(read?.status).toBe("CREATED");
  });

  it("lets exactly one of two concurrent state writes win", async () => {
    const attempt = attemptFor();
    await store.createAttempt(attempt);

    const [a, b] = await Promise.all([
      store.writeAttemptState(attempt.attempt_id, 1, { page: "a" }),
      store.writeAttemptState(attempt.attempt_id, 1, { page: "b" }),
    ]);
    const outcomes = [a!.outcome, b!.outcome].sort();
    expect(outcomes).toEqual(["APPLIED", "CONFLICT"]);
    expect((await store.getAttempt(attempt.attempt_id))?.revision).toBe(2);
  });

  it("refuses a state write against a terminal attempt", async () => {
    const attempt = attemptFor();
    await store.createAttempt(attempt);
    await store.writeAttemptState(attempt.attempt_id, 1, { page: 1 });
    expect((await store.transitionAttempt(attempt.attempt_id, "COMPLETED")).outcome).toBe("APPLIED");
    expect((await store.writeAttemptState(attempt.attempt_id, 2, { page: 2 })).outcome).toBe("CONFLICT");
  });

  it("applies a completion once when two replicas race", async () => {
    const attempt = attemptFor({ status: "STARTED" });
    await store.createAttempt(attempt);
    const results = await Promise.all([
      store.transitionAttempt(attempt.attempt_id, "COMPLETED"),
      store.transitionAttempt(attempt.attempt_id, "COMPLETED"),
    ]);
    expect(results.filter((result) => result.outcome === "APPLIED")).toHaveLength(1);
  });

  it("expires an attempt whose session window has passed", async () => {
    const attempt = attemptFor({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await store.createAttempt(attempt);
    await store.expireStaleAttempts();
    expect((await store.getAttempt(attempt.attempt_id))?.status).toBe("EXPIRED");
  });

  it("replays an idempotency record and reports a changed request", async () => {
    const key = randomUUID();
    await store.recordIdempotent("test-scope", key, "fingerprint-a", 201, { attempt_id: "one" }, 60000);

    const same = await store.replayIdempotent("test-scope", key, "fingerprint-a");
    expect(same?.mismatch).toBe(false);
    expect((same?.response as { attempt_id: string }).attempt_id).toBe("one");

    const different = await store.replayIdempotent("test-scope", key, "fingerprint-b");
    expect(different?.mismatch).toBe(true);

    // The same key under another surface is a different record, so one endpoint's response can never
    // be replayed by another.
    expect(await store.replayIdempotent("other-scope", key, "fingerprint-a")).toBeUndefined();
  });

  it("hands a concurrently claimed key to exactly one caller", async () => {
    const key = randomUUID();
    // Two replicas, two pools, one key, at the same moment. This is the case a
    // check-then-write-afterwards implementation cannot get right: both would see no record, both
    // would do the work, and only then would one of the two responses survive.
    const otherPool = new pg.Pool({ connectionString: DATABASE_URL });
    const other = new PostgresRuntimeStore(otherPool);
    try {
      const claims = await Promise.all([
        store.claimIdempotent("concurrent-scope", key, "fingerprint", 60000),
        other.claimIdempotent("concurrent-scope", key, "fingerprint", 60000),
      ]);
      expect(claims.filter((claim) => claim.state === "reserved")).toHaveLength(1);
      expect(claims.filter((claim) => claim.state === "in_flight")).toHaveLength(1);

      // Until the winner completes, the loser's retry is still told the work is in flight — never
      // handed a half-finished answer and never allowed to repeat the work.
      expect((await other.claimIdempotent("concurrent-scope", key, "fingerprint", 60000)).state).toBe("in_flight");

      await store.completeIdempotent("concurrent-scope", key, 201, { attempt_id: "the-only-one" });
      const replay = await other.claimIdempotent("concurrent-scope", key, "fingerprint", 60000);
      expect(replay).toEqual({ state: "replay", status_code: 201, response: { attempt_id: "the-only-one" } });

      // A different request under the same key is refused rather than replayed.
      expect((await store.claimIdempotent("concurrent-scope", key, "other-fingerprint", 60000)).state).toBe("mismatch");
    } finally {
      await otherPool.end();
    }
  });

  it("frees a claim whose work never produced a response", async () => {
    const key = randomUUID();
    expect((await store.claimIdempotent("release-scope", key, "fingerprint", 60000)).state).toBe("reserved");
    await store.releaseIdempotent("release-scope", key);
    expect((await store.claimIdempotent("release-scope", key, "fingerprint", 60000)).state).toBe("reserved");

    // A completed claim is not released: the stored response outlives the request that made it.
    await store.completeIdempotent("release-scope", key, 201, { kept: true });
    await store.releaseIdempotent("release-scope", key);
    expect((await store.claimIdempotent("release-scope", key, "fingerprint", 60000)).state).toBe("replay");
  });

  it("lets an expired key be claimed again rather than replaying a stale response", async () => {
    const key = randomUUID();
    await store.claimIdempotent("expiry-scope", key, "fingerprint", 1);
    await store.completeIdempotent("expiry-scope", key, 201, { stale: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await store.claimIdempotent("expiry-scope", key, "fingerprint", 60000)).state).toBe("reserved");
  });

  it("purges idempotency records once they expire", async () => {
    const key = randomUUID();
    await store.recordIdempotent("test-scope", key, "f", 201, {}, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.replayIdempotent("test-scope", key, "f")).toBeUndefined();
    await store.purgeExpiredIdempotency();
  });

  it("deduplicates a statement by its UUID", async () => {
    const statementId = randomUUID();
    const row = {
      outbox_id: randomUUID(), statement_id: statementId, repository_id: repositoryId,
      attempt_id: randomUUID(), package_version_id: packageVersionId, object_id: objectId,
      actor_pseudonym: "b".repeat(64), verb_id: "http://adlnet.gov/expapi/verbs/completed",
      payload: { id: statementId }, created_at: new Date().toISOString(), correlation_id: randomUUID(),
    };
    expect(await store.enqueueStatement(row)).toBe(true);
    expect(await store.enqueueStatement({ ...row, outbox_id: randomUUID() })).toBe(false);
  });

  it("never hands the same statement to two forwarder replicas", async () => {
    const statementId = randomUUID();
    await store.enqueueStatement({
      outbox_id: randomUUID(), statement_id: statementId, repository_id: repositoryId,
      attempt_id: randomUUID(), package_version_id: packageVersionId, object_id: objectId,
      actor_pseudonym: "c".repeat(64), verb_id: "http://adlnet.gov/expapi/verbs/completed",
      payload: { id: statementId }, created_at: new Date().toISOString(), correlation_id: randomUUID(),
    });

    const [first, second] = await Promise.all([
      store.claimDueStatements("replica-one", 50),
      store.claimDueStatements("replica-two", 50),
    ]);
    const claimedByBoth = first!.filter((row) => second!.some((other) => other.statement_id === row.statement_id));
    expect(claimedByBoth).toHaveLength(0);
    expect([...first!, ...second!].filter((row) => row.statement_id === statementId)).toHaveLength(1);
  });

  it("refuses to rewrite the payload of an accepted statement", async () => {
    const statementId = randomUUID();
    const outboxId = randomUUID();
    await store.enqueueStatement({
      outbox_id: outboxId, statement_id: statementId, repository_id: repositoryId,
      attempt_id: randomUUID(), package_version_id: packageVersionId, object_id: objectId,
      actor_pseudonym: "d".repeat(64), verb_id: "http://adlnet.gov/expapi/verbs/completed",
      payload: { id: statementId, original: true }, created_at: new Date().toISOString(), correlation_id: randomUUID(),
    });
    await expect(
      pool.query("update evidence_outbox set payload = $2 where outbox_id = $1", [outboxId, JSON.stringify({ tampered: true })]),
    ).rejects.toThrow(/EVIDENCE_STATEMENT_IMMUTABLE/);
    await expect(
      pool.query("delete from evidence_outbox where outbox_id = $1", [outboxId]),
    ).rejects.toThrow(/EVIDENCE_STATEMENT_IMMUTABLE/);
  });

  it("publishes a new object version without modifying the previous one", async () => {
    const before = await catalogue.learningObject(objectId);
    const updated = await catalogue.publishObjectVersion(objectId, {
      semver: "1.1.0", module_path: "/module/v2/index.html", sha256: "e".repeat(64),
    });
    expect(updated!.active_package_version_id).not.toBe(before!.active_package_version_id);

    // The superseded row is still there, unchanged, so a descriptor that pinned it still resolves.
    const previous = await catalogue.packageVersion(before!.active_package_version_id);
    expect(previous?.sha256).toBe("c".repeat(64));
    expect(previous?.status).toBe("SUPERSEDED");
  });
});
