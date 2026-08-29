/**
 * Bookmarking ("importing") a marketplace-listed object into another administrator's own assignable
 * set. Needs Postgres: the bookmark lives in `marketplace_import`, a roster-adjacent table alongside
 * `class`/`class_assignment`, the same reason tests/runtime-api/class-roster.spec.ts needs it.
 *
 * What matters here: only an object its own repository opted in to listing can be bookmarked, the
 * bookmark is what GET /api/v1/admin/marketplace/imports resolves against, and — the point of the
 * whole feature — the object becomes assignable to the importing administrator's own class exactly
 * as if it were their own content, with nothing copied and no change to the object's repository.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { PostgresCatalogueStore } from "../../packages/runtime-api/src/catalogue/postgres.js";
import { PostgresRuntimeStore } from "../../packages/runtime-api/src/store/postgres.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lorb:lorb@localhost:5432/lorb";
process.env.DATABASE_URL = DATABASE_URL;
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const ISSUER = "https://ies.marketplace-import.test";

describeIfDatabase("Marketplace import", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let publisherToken: string;
  let teacherToken: string;
  let otherTeacherToken: string;
  let learnerToken: string;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, as = teacherToken) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  beforeAll(async () => {
    process.env.ADMIN_ALLOWED_ROLES = "admin";
    const keys = await generateKeyPair("ES256");
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalogue = new PostgresCatalogueStore(pool);
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: ISSUER, playerOrigin: "https://player.marketplace-import.test",
      secret: Buffer.alloc(32, 13), store: new PostgresRuntimeStore(pool), catalogue,
    });
    publisherToken = await issueIesToken(keys.privateKey as never, `publisher-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });
    teacherToken = await issueIesToken(keys.privateKey as never, `teacher-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });
    otherTeacherToken = await issueIesToken(keys.privateKey as never, `other-teacher-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });
    learnerToken = await issueIesToken(keys.privateKey as never, `learner-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, {});
  });

  afterAll(async () => {
    await runtime?.app.close();
    await pool?.end();
  });

  /** A published quiz, registered and owned by `publisherToken`'s own fresh repository, listed on
   *  the marketplace unless `listed` is false. `teacherToken` has no membership in this repository. */
  const listedObject = async (listed = true) => {
    const repository = await runtime.app.inject({
      method: "POST", url: "/api/v1/admin/repositories",
      headers: { authorization: `Bearer ${publisherToken}`, "idempotency-key": randomUUID() },
      payload: { slug: `marketplace-${randomUUID().slice(0, 8)}`, display_name: "Another publisher" },
    });
    expect(repository.statusCode).toBe(201);
    const repositoryId = repository.json().repository_id as string;

    const quiz = await runtime.app.inject({
      method: "POST", url: "/api/v1/publisher/learning-objects/quizzes",
      headers: { authorization: `Bearer ${publisherToken}`, "idempotency-key": randomUUID() },
      payload: {
        repository_id: repositoryId, title: "Bookmarkable quiz",
        questions: [{ stem: "2 + 2?", options: [{ id: "a", text: "4" }, { id: "b", text: "5" }], correct_option_id: "a" }],
      },
    });
    expect(quiz.statusCode).toBe(201);
    const objectId = quiz.json().object_id as string;

    if (listed) {
      const list = await runtime.app.inject({
        method: "PUT", url: `/api/v1/publisher/learning-objects/${objectId}/marketplace-listing`,
        headers: { authorization: `Bearer ${publisherToken}`, "idempotency-key": randomUUID() },
        payload: { listed: true },
      });
      expect(list.statusCode).toBe(200);
    }
    return { objectId, repositoryId };
  };

  it("shows a listed object on the marketplace with its publisher's name", async () => {
    const { objectId } = await listedObject();
    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    expect(marketplace.statusCode).toBe(200);
    const items = marketplace.json().items as Array<{ object_id: string; publisher_name: string }>;
    expect(items.map((item) => item.object_id)).toContain(objectId);
    expect(items.find((item) => item.object_id === objectId)?.publisher_name).toBe("Another publisher");
  });

  it("refuses to bookmark an object that was never listed", async () => {
    const { objectId } = await listedObject(false);
    const response = await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("LEARNING_OBJECT_NOT_FOUND");
  });

  it("refuses to bookmark an object that does not exist", async () => {
    const response = await call("POST", "/api/v1/admin/marketplace/imports", { object_id: randomUUID() });
    expect(response.statusCode).toBe(404);
  });

  it("bookmarks a listed object, and it shows up in the caller's own imports", async () => {
    const { objectId } = await listedObject();
    const imported = await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId });
    expect(imported.statusCode).toBe(201);

    const mine = await call("GET", "/api/v1/admin/marketplace/imports");
    expect((mine.json().items as Array<{ object_id: string }>).map((item) => item.object_id)).toContain(objectId);

    // A bookmark is private to the administrator who made it.
    const theirs = await call("GET", "/api/v1/admin/marketplace/imports", undefined, otherTeacherToken);
    expect((theirs.json().items as Array<{ object_id: string }>).map((item) => item.object_id)).not.toContain(objectId);
  });

  it("bookmarking the same object twice does not duplicate it", async () => {
    const { objectId } = await listedObject();
    await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId });
    await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId });
    const rows = await pool.query(
      "select count(*)::int as n from marketplace_import where object_id = $1",
      [objectId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("removes a bookmark on delete, without touching the object", async () => {
    const { objectId } = await listedObject();
    await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId });
    const removed = await call("DELETE", `/api/v1/admin/marketplace/imports/${objectId}`);
    expect(removed.statusCode).toBe(204);
    const mine = await call("GET", "/api/v1/admin/marketplace/imports");
    expect((mine.json().items as Array<{ object_id: string }>).map((item) => item.object_id)).not.toContain(objectId);
    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    expect((marketplace.json().items as Array<{ object_id: string }>).map((item) => item.object_id)).toContain(objectId);
  });

  it("refuses reads and writes from a non-admin caller", async () => {
    const { objectId } = await listedObject();
    expect((await call("GET", "/api/v1/admin/marketplace", undefined, learnerToken)).statusCode).toBe(403);
    expect((await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId }, learnerToken)).statusCode).toBe(403);
  });

  it("makes a bookmarked object assignable to the importing teacher's own class", async () => {
    const { objectId } = await listedObject();
    expect((await call("POST", "/api/v1/admin/marketplace/imports", { object_id: objectId })).statusCode).toBe(201);

    const created = await call("POST", "/api/v1/admin/classes", { name: `Marketplace class ${randomUUID().slice(0, 6)}` });
    expect(created.statusCode).toBe(201);
    const classId = created.json().class_id as string;
    await call("POST", `/api/v1/admin/classes/${classId}/learners`, {
      learners: [{ learner_ref: `synthetic-marketplace-${randomUUID().slice(0, 8)}`, display_name: "Imported Learner" }],
    });

    const assigned = await call("POST", `/api/v1/admin/classes/${classId}/assignments`, { object_id: objectId });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json().object_id).toBe(objectId);
  });
});
