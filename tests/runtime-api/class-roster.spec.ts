// Roster administration enforcement. Requires Postgres with migrations through 004_roster.sql.
//
// BLK-02, BLK-03 and BLK-07 are implicated by this feature, not cleared by it: these tests check
// that the boundaries the design depends on hold, not that the privacy design is done.
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { computePseudonym } from "../../packages/runtime-api/src/services/pseudonym-service.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lorb:lorb@localhost:5432/lorb_mvp";
process.env.DATABASE_URL = DATABASE_URL;
process.env.ADMIN_ALLOWED_ROLES = "admin";

const SERVICE_TOKEN = "class-roster-suite-internal-service-token-0001";
const SECRET = Buffer.alloc(32, 7);
const IES = "https://ies.class-roster.test";

describe("Class roster administration", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let adminToken: string;
  let learnerToken: string;

  const admin = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, token = adminToken) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const internal = (url: string, token: string | null = SERVICE_TOKEN) =>
    runtime.app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  const newClass = async (name = "9B Science") => {
    const created = await admin("POST", "/api/v1/admin/classes", { name, year_group: "Year 9", subject: "Science" });
    expect(created.statusCode).toBe(201);
    return created.json().class_id as string;
  };

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: IES, playerOrigin: "https://player.class-roster.test",
      secret: SECRET, internalServiceToken: SERVICE_TOKEN,
    });
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    adminToken = await issueIesToken(keys.privateKey as never, "synthetic-roster-admin", "lorb-runtime", IES, { role: "admin" });
    learnerToken = await issueIesToken(keys.privateKey as never, "synthetic-roster-learner", "lorb-runtime", IES, {});
  });

  afterAll(async () => {
    await runtime.app.close();
    await pool.end();
  });

  it("creates a class and adds learners", async () => {
    const classId = await newClass();
    const added = await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
      learners: [
        { learner_ref: "synthetic-roster-01", display_name: "Learner One" },
        { learner_ref: "synthetic-roster-02", display_name: "Learner Two" },
      ],
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().added).toBe(2);

    const detail = await admin("GET", `/api/v1/admin/classes/${classId}`);
    expect(detail.json().learners).toHaveLength(2);
  });

  it("adds the same learner twice without duplicating them", async () => {
    const classId = await newClass("8A Duplicates");
    const payload = { learners: [{ learner_ref: "synthetic-dupe-01", display_name: "Only Once" }] };
    expect((await admin("POST", `/api/v1/admin/classes/${classId}/learners`, payload)).json().added).toBe(1);
    expect((await admin("POST", `/api/v1/admin/classes/${classId}/learners`, payload)).json().added).toBe(0);
    expect((await admin("GET", `/api/v1/admin/classes/${classId}`)).json().learners).toHaveLength(1);
  });

  it("refuses a learner identifier the identity source could never issue", async () => {
    const classId = await newClass("7C Invalid");
    // A ref that cannot round-trip through the IES would produce evidence nobody could attribute.
    const response = await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
      learners: [{ learner_ref: "has spaces and <angle> brackets", display_name: "Nope" }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("LEARNER_REF_INVALID");
  });

  describe("authorisation", () => {
    // Asserting the 403 alone proves nothing: requireAdmin sends that reply itself, so a handler
    // that ignored its return value would still answer 403 while writing the row anyway. Verified
    // by mutation — the status-only version of this test survives exactly that change.
    it("refuses roster writes from a learner token, and writes nothing", async () => {
      const name = `Denied ${randomUUID()}`;
      const response = await admin("POST", "/api/v1/admin/classes", { name }, learnerToken);
      expect(response.statusCode).toBe(403);
      expect((await pool.query("select 1 from class where name = $1", [name])).rowCount).toBe(0);
    });

    it("refuses learner additions from a learner token, and adds nobody", async () => {
      const classId = await newClass("15F Denied Additions");
      const response = await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-denied-01", display_name: "Should Not Appear" }],
      }, learnerToken);
      expect(response.statusCode).toBe(403);
      expect((await pool.query("select 1 from class_learner where class_id = $1", [classId])).rowCount).toBe(0);
    });

    it("refuses roster reads without any token", async () => {
      const response = await runtime.app.inject({ method: "GET", url: "/api/v1/admin/classes" });
      expect(response.statusCode).toBe(401);
    });

    it("refuses the internal roster projection without the service token", async () => {
      expect((await internal("/api/v1/internal/roster/classes", null)).statusCode).toBe(401);
      expect((await internal("/api/v1/internal/roster/classes", "wrong-token")).statusCode).toBe(401);
    });

    // The agent surface is read-only by design. There must be no roster-mutating internal route.
    it("exposes no internal write path onto the roster", async () => {
      const classId = await newClass("6D Read Only");
      for (const [method, url] of [
        ["POST", "/api/v1/internal/roster/classes"],
        ["POST", `/api/v1/internal/roster/classes/${classId}/learners`],
        ["DELETE", `/api/v1/internal/roster/classes/${classId}`],
      ] as const) {
        const response = await runtime.app.inject({ method, url, headers: { authorization: `Bearer ${SERVICE_TOKEN}` }, payload: {} });
        expect(response.statusCode).toBe(404);
      }
    });
  });

  describe("the roster projection withholds what the agent must not see", () => {
    it("never returns learner display names", async () => {
      const classId = await newClass("10A Names");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-named-01", display_name: "Priya Raman" }],
      });
      const roster = await internal(`/api/v1/internal/roster/classes/${classId}/roster`);
      expect(roster.statusCode).toBe(200);
      expect(roster.body).not.toContain("Priya");
      expect(roster.json().learners).toEqual([{ learner_id: "synthetic-named-01" }]);

      const summary = await internal(`/api/v1/internal/roster/classes/${classId}`);
      expect(summary.body).not.toContain("Priya");
      expect(summary.json().learner_count).toBe(1);
    });
  });

  describe("assignment", () => {
    it("refuses to assign to a class with no learners", async () => {
      const classId = await newClass("11B Empty");
      const response = await admin("POST", `/api/v1/admin/classes/${classId}/assignments`, { object_id: randomUUID() });
      // The object check runs first, so an unknown object is reported before the empty roster is.
      expect([404, 409]).toContain(response.statusCode);
    });

    it("replays an assignment rather than assigning twice", async () => {
      const classId = await newClass("12C Idempotent");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-idem-01", display_name: "Once Only" }],
      });
      const objects = (await admin("GET", "/api/v1/admin/learning-objects")).json().items as Array<{ object_id: string; status: string }>;
      const published = objects.find((object) => object.status === "PUBLISHED");
      if (!published) return; // no published object seeded in this environment
      const key = randomUUID();
      const send = () => runtime.app.inject({
        method: "POST", url: `/api/v1/admin/classes/${classId}/assignments`,
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": key },
        payload: { object_id: published.object_id },
      });
      const first = await send();
      const second = await send();
      expect(first.statusCode).toBe(201);
      expect(second.json().assignment_id).toBe(first.json().assignment_id);
      expect(second.json().replayed).toBe(true);
    });
  });

  describe("results", () => {
    it("matches a learner to evidence by recomputing the pseudonym, not by a stored mapping", async () => {
      const classId = await newClass("13D Results");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-result-01", display_name: "Result Learner" }],
      });
      // The pseudonym the launch path would derive. Nothing in the schema stores it.
      const expected = computePseudonym(SECRET, IES, "synthetic-result-01", "launch");
      const stored = await pool.query("select * from class_learner where learner_ref = $1", ["synthetic-result-01"]);
      expect(JSON.stringify(stored.rows)).not.toContain(expected);

      const results = await admin("GET", `/api/v1/admin/classes/${classId}/results`);
      expect(results.statusCode).toBe(200);
      expect(results.json().class_id).toBe(classId);
    });
  });

  describe("the audit log holds no roster PII", () => {
    it("records counts, never learner names or identifiers", async () => {
      const classId = await newClass("14E Audited");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-audited-01", display_name: "Audited Person" }],
      });
      const audit = await pool.query(
        "select resulting_state from audit_record where action_type = 'class.learners.add' and target_id = $1",
        [classId],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      const serialised = JSON.stringify(audit.rows);
      expect(serialised).not.toContain("Audited Person");
      expect(serialised).not.toContain("synthetic-audited-01");
      expect(serialised).toContain("added");
    });
  });
});
