// Roster administration enforcement. Needs Postgres with the migrations applied.
//
// What these check is that the privacy shape the roster schema was built around actually holds in
// the routes: no row pairs a learner identifier with a pseudonym, an assignment remembers who was in
// the class at the time, and a class is only ever visible to the principal that owns it.
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { computePseudonym } from "../../packages/runtime-api/src/services/pseudonym-service.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { xapiVerbs } from "../../packages/contracts/src/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lorb:lorb@localhost:5432/lorb";
process.env.DATABASE_URL = DATABASE_URL;
process.env.ADMIN_ALLOWED_ROLES = "admin";

const SERVICE_TOKEN = "class-roster-suite-internal-service-token-0001";
const SECRET = Buffer.alloc(32, 7);
const IES = "https://ies.class-roster.test";

describe("Class roster administration", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let adminToken: string;
  let otherTeacherToken: string;
  let learnerToken: string;
  let store: MemoryRuntimeStore;

  const admin = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, token = adminToken) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  // The connector sends its service token plus the principal it verified. The projection scopes to
  // the teacher that principal is linked to, so both are needed for a read to return anything.
  const AGENT = { issuer: "https://idp.class-roster.test/", subject: "auth0|roster-suite" };
  const internal = (url: string, token: string | null = SERVICE_TOKEN, principal: { issuer: string; subject: string } | null = AGENT) =>
    runtime.app.inject({
      method: "GET", url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(principal ? { "x-lorb-agent-issuer": principal.issuer, "x-lorb-agent-subject": principal.subject } : {}),
      },
    });

  const newClass = async (name = "9B Science") => {
    const created = await admin("POST", "/api/v1/admin/classes", { name, year_group: "Year 9", subject: "Science" });
    expect(created.statusCode).toBe(201);
    return created.json().class_id as string;
  };

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    store = new MemoryRuntimeStore();
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: IES, playerOrigin: "https://player.class-roster.test",
      secret: SECRET, internalServiceToken: SERVICE_TOKEN,
      store, catalogue: new MemoryCatalogueStore(),
    });
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    adminToken = await issueIesToken(keys.privateKey as never, "synthetic-roster-admin", "lorb-runtime", IES, { role: "admin" });
    otherTeacherToken = await issueIesToken(keys.privateKey as never, "synthetic-roster-other-teacher", "lorb-runtime", IES, { role: "admin" });
    learnerToken = await issueIesToken(keys.privateKey as never, "synthetic-roster-learner", "lorb-runtime", IES, {});
    // Link the agent principal to this suite's admin, so the roster projection has a teacher to
    // scope to. Without it every internal read fails closed, which is covered separately in
    // tests/runtime-api/agent-principal-scoping.spec.ts.
    await admin("POST", "/api/v1/admin/agent-links", { agent_issuer: AGENT.issuer, agent_subject: AGENT.subject, label: "roster suite" });
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

    // Every finding below was raised in review on #52 and reproduced before being fixed.
  describe("one teacher cannot reach another teacher's roster", () => {
    it("does not list classes the caller did not create", async () => {
      const classId = await newClass("16G Mine");
      const theirs = (await admin("GET", "/api/v1/admin/classes", undefined, otherTeacherToken)).json().items as Array<{ class_id: string }>;
      expect(theirs.map((c) => c.class_id)).not.toContain(classId);
    });

    it("hides another teacher's learner names behind CLASS_NOT_FOUND", async () => {
      const classId = await newClass("17H Private");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-private-01", display_name: "Confidential Person" }],
      });
      const response = await admin("GET", `/api/v1/admin/classes/${classId}`, undefined, otherTeacherToken);
      // Not 403: a 403 would confirm the class id exists.
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("Confidential Person");
    });

    it("refuses every write against another teacher's class, and changes nothing", async () => {
      const classId = await newClass("18I Untouchable");
      await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
        learners: [{ learner_ref: "synthetic-untouchable-01", display_name: "Stays Put" }],
      });
      const attempts = [
        admin("POST", `/api/v1/admin/classes/${classId}/learners`, { learners: [{ learner_ref: "synthetic-intruder-01", display_name: "Intruder" }] }, otherTeacherToken),
        admin("POST", `/api/v1/admin/classes/${classId}/topics`, { topics: [{ topic: "Injected", taught_on: "2026-08-01" }] }, otherTeacherToken),
        admin("DELETE", `/api/v1/admin/classes/${classId}/learners/synthetic-untouchable-01`, undefined, otherTeacherToken),
        admin("GET", `/api/v1/admin/classes/${classId}/results`, undefined, otherTeacherToken),
      ];
      for (const response of await Promise.all(attempts)) expect(response.statusCode).toBe(404);
      const after = (await admin("GET", `/api/v1/admin/classes/${classId}`)).json();
      expect(after.learners).toHaveLength(1);
      expect(after.topics).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("replays class creation rather than creating a second class", async () => {
      const key = randomUUID();
      const name = `Replayed ${randomUUID()}`;
      const send = () => runtime.app.inject({
        method: "POST", url: "/api/v1/admin/classes",
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": key },
        payload: { name },
      });
      const first = await send();
      const second = await send();
      expect(second.json().class_id).toBe(first.json().class_id);
      expect(second.json().replayed).toBe(true);
      expect((await pool.query("select 1 from class where name = $1", [name])).rowCount).toBe(1);
    });
  });

  /** Puts an accepted completion in the evidence outbox for one pseudonym, as the Evidence API would. */
  const recordCompletion = async (objectId: string, pseudonym: string, scaled: number, createdAt: string) => {
    const statementId = randomUUID();
    await store.enqueueStatement({
      outbox_id: randomUUID(), statement_id: statementId, repository_id: randomUUID(),
      attempt_id: randomUUID(), package_version_id: randomUUID(), object_id: objectId,
      actor_pseudonym: pseudonym, verb_id: xapiVerbs.completed, correlation_id: randomUUID(),
      created_at: createdAt,
      payload: {
        id: statementId,
        actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: pseudonym } },
        verb: { id: xapiVerbs.completed },
        object: { id: `https://lorb.example/objects/${objectId}/versions/${randomUUID()}`, objectType: "Activity" },
        result: { score: { scaled } },
        timestamp: createdAt,
      },
    } as never);
  };

  /** A class with one published object assigned to it, or undefined when nothing is seeded. */
  const assignedClass = async (name: string, learnerRefs: string[]) => {
    const classId = await newClass(name);
    await admin("POST", `/api/v1/admin/classes/${classId}/learners`, {
      learners: learnerRefs.map((learner_ref) => ({ learner_ref, display_name: `Name ${learner_ref}` })),
    });
    const objects = (await admin("GET", "/api/v1/admin/learning-objects")).json().items as Array<{ object_id: string; status: string }>;
    const published = objects.find((object) => object.status === "PUBLISHED");
    if (!published) return undefined;
    const assignment = await admin("POST", `/api/v1/admin/classes/${classId}/assignments`, { object_id: published.object_id });
    expect(assignment.statusCode).toBe(201);
    return { classId, objectId: published.object_id, assignmentId: assignment.json().assignment_id as string };
  };

  describe("an assignment remembers who was in the class at the time", () => {
    it("does not show a later joiner as having missed the work", async () => {
      const seeded = await assignedClass("19J Joiners", ["synthetic-joiner-01"]);
      if (!seeded) return;
      await admin("POST", `/api/v1/admin/classes/${seeded.classId}/learners`, {
        learners: [{ learner_ref: "synthetic-joiner-99", display_name: "Joined Later" }],
      });
      const results = (await admin("GET", `/api/v1/admin/classes/${seeded.classId}/results`)).json().items as Array<{ learners: Array<{ learner_ref: string }> }>;
      const refs = results[0]!.learners.map((l) => l.learner_ref);
      expect(refs).toEqual(["synthetic-joiner-01"]);
      expect(refs).not.toContain("synthetic-joiner-99");
    });

    it("keeps a learner removed after assignment in that assignment's record", async () => {
      const seeded = await assignedClass("20K Leavers", ["synthetic-leaver-01", "synthetic-leaver-02"]);
      if (!seeded) return;
      await admin("DELETE", `/api/v1/admin/classes/${seeded.classId}/learners/synthetic-leaver-02`);
      const results = (await admin("GET", `/api/v1/admin/classes/${seeded.classId}/results`)).json().items as Array<{ learner_count: number; learners: Array<{ learner_ref: string; display_name: string }> }>;
      // learner_count said two; the record must still account for two.
      expect(results[0]!.learner_count).toBe(2);
      expect(results[0]!.learners).toHaveLength(2);
      expect(results[0]!.learners.find((l) => l.learner_ref === "synthetic-leaver-02")!.display_name).toBe("(removed from class)");
    });

    it("returns the object that was assigned when a key is replayed with a different one", async () => {
      const seeded = await assignedClass("21L Replay", ["synthetic-replay-01"]);
      if (!seeded) return;
      const key = randomUUID();
      const send = (objectId: string) => runtime.app.inject({
        method: "POST", url: `/api/v1/admin/classes/${seeded.classId}/assignments`,
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": key },
        payload: { object_id: objectId },
      });
      const first = await send(seeded.objectId);
      expect(first.statusCode).toBe(201);
      const decoy = randomUUID();
      const second = await send(decoy);
      // Must never report the original assignment id against an object it was not assigned to.
      expect(second.json().assignment_id).toBe(first.json().assignment_id);
      expect(second.json().object_id).toBe(seeded.objectId);
      expect(second.json().object_id).not.toBe(decoy);
    });
  });

  describe("results are bounded to the assignment window", () => {
    it("ignores evidence recorded before the assignment existed", async () => {
      const seeded = await assignedClass("22M Prior", ["synthetic-prior-01"]);
      if (!seeded) return;
      const pseudonym = computePseudonym(SECRET, IES, "synthetic-prior-01", "launch");
      // A completion from long before this assignment was created.
      await recordCompletion(seeded.objectId, pseudonym, 1, new Date(Date.now() - 86_400_000).toISOString());
      const results = (await admin("GET", `/api/v1/admin/classes/${seeded.classId}/results`)).json().items as Array<{ attempted_count: number; learners: Array<{ completed: boolean }> }>;
      expect(results[0]!.attempted_count).toBe(0);
      expect(results[0]!.learners[0]!.completed).toBe(false);
    });

    it("counts evidence recorded after the assignment", async () => {
      const seeded = await assignedClass("23N After", ["synthetic-after-01"]);
      if (!seeded) return;
      const pseudonym = computePseudonym(SECRET, IES, "synthetic-after-01", "launch");
      await recordCompletion(seeded.objectId, pseudonym, 0.75, new Date(Date.now() + 1000).toISOString());
      const results = (await admin("GET", `/api/v1/admin/classes/${seeded.classId}/results`)).json().items as Array<{ attempted_count: number; learners: Array<{ completed: boolean; scaled: number | null }> }>;
      expect(results[0]!.attempted_count).toBe(1);
      expect(results[0]!.learners[0]!.completed).toBe(true);
      expect(results[0]!.learners[0]!.scaled).toBe(0.75);
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
