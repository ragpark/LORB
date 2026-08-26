/**
 * Authoring against the real catalogue.
 *
 * The in-memory suite (publisher-authoring.spec.ts) states what the surface promises. This one
 * checks the promises that are only meaningful against Postgres, and that are exactly the ones a
 * mistake in the SQL would break silently:
 *
 *   - repository membership actually scopes who may publish into what, rather than every
 *     administrator being able to edit every repository's catalogue;
 *   - a content edit writes an immutable content version and moves the pointer, so the questions a
 *     learner answered are still there after they have been replaced;
 *   - a metadata edit's SQL touches the columns it names and no others — the pointer a launch
 *     resolves through survives a title change;
 *   - deletion removes the rows that describe an object, package versions included, and the
 *     foreign key from `attempt` stops it where evidence exists.
 *
 * Needs Postgres. Without DATABASE_URL there is nothing here to check and the suite skips.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { PostgresCatalogueStore } from "../../packages/runtime-api/src/catalogue/postgres.js";
import { PostgresRuntimeStore } from "../../packages/runtime-api/src/store/postgres.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const ISSUER = "https://ies.publisher-authoring.test";

describeIfDatabase("Publisher authoring against Postgres", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let catalogue: PostgresCatalogueStore;
  let token: string;
  let outsiderToken: string;
  let repositoryId: string;

  beforeAll(async () => {
    process.env.ADMIN_ALLOWED_ROLES = "admin";
    const keys = await generateKeyPair("ES256");
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalogue = new PostgresCatalogueStore(pool);
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: ISSUER,
      playerOrigin: "https://player.publisher-authoring.test",
      secret: Buffer.alloc(32, 11), store: new PostgresRuntimeStore(pool), catalogue,
    });
    token = await issueIesToken(keys.privateKey as never, `author-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });
    outsiderToken = await issueIesToken(keys.privateKey as never, `outsider-${randomUUID().slice(0, 8)}`, "lorb-runtime", ISSUER, { role: "admin" });

    // Creating a repository grants the caller owner membership, which is what authorises publishing.
    const created = await runtime.app.inject({
      method: "POST", url: "/api/v1/admin/repositories",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { slug: `auth-${randomUUID().slice(0, 8)}`, display_name: "Publisher authoring suite" },
    });
    expect(created.statusCode).toBe(201);
    repositoryId = created.json().repository_id;
  });

  afterAll(async () => {
    await runtime?.app.close();
    await pool?.end();
  });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, as = token) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  const registerObject = async (title = "Packaged activity") => {
    const created = await call("POST", "/api/v1/publisher/learning-objects", {
      repository_id: repositoryId, title,
      module_path: `/modules/${randomUUID().slice(0, 8)}/index.html`,
      semver: "1.0.0", sha256: "d".repeat(64),
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  };

  const authorQuiz = async (title = "Authored quiz") => {
    const created = await call("POST", "/api/v1/publisher/learning-objects/quizzes", {
      repository_id: repositoryId, title,
      questions: [{ stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" }],
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  };

  it("refuses an administrator with no membership of the repository, and records the refusal", async () => {
    const object = await registerObject("Membership-scoped");
    const refused = await call("PATCH", `/api/v1/publisher/learning-objects/${object.object_id}`, { title: "Not yours" }, outsiderToken);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("MEMBERSHIP_NOT_PERMITTED");

    const audited = await pool.query(
      "select outcome, reason from audit_record where target_id = $1 and action_type = 'learning_object.update' order by created_at desc limit 1",
      [object.object_id],
    );
    expect(audited.rows[0]?.outcome).toBe("DENIED");
    expect(audited.rows[0]?.reason).toBe("MEMBERSHIP_NOT_PERMITTED");

    // And the object is exactly as it was.
    expect((await catalogue.learningObject(object.object_id))?.title).toBe("Membership-scoped");
  });

  it("edits the catalogue entry without disturbing the row a launch resolves through", async () => {
    const object = await registerObject("Before the edit");
    const edited = await call("PATCH", `/api/v1/publisher/learning-objects/${object.object_id}`, {
      title: "After the edit", description: "Rewritten.",
    });
    expect(edited.statusCode).toBe(200);

    const row = (await pool.query("select * from learning_object where object_id = $1", [object.object_id])).rows[0];
    expect(row.title).toBe("After the edit");
    expect(row.description).toBe("Rewritten.");
    expect(row.active_package_version_id).toBe(object.active_package_version_id);
    expect(row.active_object_version_id).toBe(object.active_object_version_id);
    expect(row.module_path).toBe(object.module_path);
    // Untouched columns keep their values rather than being reset by a partial update.
    expect(row.duration).toBe("");
    expect(row.kind).toBe("native-web-package");
  });

  it("writes an immutable content version per edit and leaves the superseded questions readable", async () => {
    const quiz = await authorQuiz("Fractions");
    const revised = await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/content`, {
      title: "Fractions, corrected",
      questions: [
        { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
        { stem: "Which is equivalent to 1/4?", options: [{ id: "a", text: "2/8" }, { id: "b", text: "3/4" }], correct_option_id: "a" },
      ],
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().content_version).toBe("2");

    const versions = await pool.query(
      "select content_version, jsonb_array_length(payload->'questions') as questions from learning_object_content_version where object_id = $1 order by content_version",
      [quiz.object_id],
    );
    expect(versions.rows.map((row) => row.content_version)).toEqual(["1", "2"]);
    expect(Number(versions.rows[0].questions)).toBe(1);
    expect(Number(versions.rows[1].questions)).toBe(2);

    // The pointer moves; what it pointed at before does not change.
    expect((await catalogue.content(quiz.object_id))?.questions).toHaveLength(2);
    expect((await catalogue.contentRevision(quiz.object_id, "1"))?.questions).toHaveLength(1);

    // The previous object version is superseded rather than rewritten, so an attempt bound to it
    // still names a row that exists.
    const objectVersions = await pool.query("select object_version_id, status, semver from object_version where object_id = $1", [quiz.object_id]);
    expect(objectVersions.rows).toHaveLength(2);
    expect(objectVersions.rows.find((row) => row.object_version_id === quiz.object_version_id)?.status).toBe("SUPERSEDED");
    expect(objectVersions.rows.map((row) => row.semver).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  it("pins a launched object version to the content it delivered", async () => {
    const quiz = await authorQuiz("Pinned content");
    await call("PUT", `/api/v1/publisher/learning-objects/${quiz.object_id}/content`, {
      title: "Pinned content",
      questions: [
        { stem: "Which is equivalent to 1/2?", options: [{ id: "a", text: "2/4" }, { id: "b", text: "1/3" }], correct_option_id: "a" },
        { stem: "And 1/4?", options: [{ id: "a", text: "2/8" }, { id: "b", text: "3/4" }], correct_option_id: "a" },
      ],
    });

    const pinned = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/runtime/learning-objects/${quiz.object_id}/content?object_version_id=${quiz.object_version_id}`,
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().questions).toHaveLength(1);

    const versions = await pool.query("select object_version_id, content_version from object_version where object_id = $1", [quiz.object_id]);
    expect(versions.rows.find((row) => row.object_version_id === quiz.object_version_id)?.content_version).toBe("1");
    expect(versions.rows.map((row) => row.content_version).sort()).toEqual(["1", "2"]);
  });

  it("deletes an unlaunched object and everything that only described it", async () => {
    const object = await registerObject("Registered by mistake");
    const link = await call("POST", `/api/v1/admin/learning-objects/${object.object_id}/smart-link`);
    expect(link.statusCode).toBe(201);

    const deleted = await call("DELETE", `/api/v1/publisher/learning-objects/${object.object_id}`);
    expect(deleted.statusCode).toBe(200);

    for (const [table, column] of [
      ["learning_object", "object_id"], ["object_version", "object_id"],
      ["package_version", "object_id"], ["smart_link", "object_id"],
    ] as const) {
      const remaining = await pool.query(`select 1 from ${table} where ${column} = $1`, [object.object_id]);
      expect(remaining.rowCount, table).toBe(0);
    }
    // The deletion itself is on the record, which is the only trace that should remain.
    const audited = await pool.query("select outcome from audit_record where target_id = $1 and action_type = 'learning_object.delete'", [object.object_id]);
    expect(audited.rows.some((row) => row.outcome === "ALLOWED")).toBe(true);
  });

  it("refuses to delete an object with an attempt against it, and leaves it launchable", async () => {
    const object = await registerObject("Already delivered");
    await runtime.store.createAttempt({
      attempt_id: randomUUID(), repository_id: repositoryId, object_id: object.object_id,
      object_version_id: object.active_object_version_id, package_version_id: object.active_package_version_id,
      pseudonym: "a".repeat(64), consumer_id: "authoring-suite", status: "COMPLETED", revision: 1,
      correlation_id: randomUUID(), created_at: new Date().toISOString(), source: "consumer",
    });

    const refused = await call("DELETE", `/api/v1/publisher/learning-objects/${object.object_id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("LEARNING_OBJECT_IN_USE");
    expect(await catalogue.learningObject(object.object_id)).toBeDefined();

    // Retirement is what that object gets instead, and it is not refused.
    const retired = await call("POST", `/api/v1/publisher/learning-objects/${object.object_id}/retire`);
    expect(retired.statusCode).toBe(200);
    expect(retired.json().status).toBe("RETIRED");
    expect((await pool.query("select retired_at from learning_object where object_id = $1", [object.object_id])).rows[0].retired_at).not.toBeNull();
  });
});
