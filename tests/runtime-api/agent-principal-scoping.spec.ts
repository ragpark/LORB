/**
 * Agent-principal scoping on the internal roster projection.
 *
 * NEEDS HUMAN LORB-001 RE-REVIEW: this is the first identity link between the agent-facing trust
 * domain and the teacher identity the roster is owned by.
 *
 * The bug these cover: the connector holds one service credential for every agent session, so the
 * projection had nothing to scope by and served every active class to any caller holding it. In
 * OIDC mode that meant any authenticated teacher could read any other teacher's class metadata and
 * pass those UUIDs to the class:// resources and assign_quiz.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lorb:lorb@localhost:5432/lorb_mvp";
process.env.DATABASE_URL = DATABASE_URL;
process.env.ADMIN_ALLOWED_ROLES = "admin";

const SERVICE_TOKEN = "agent-scoping-suite-internal-service-token-1";
const IES = "https://ies.agent-scoping.test";
const ISSUER = "https://idp.agent-scoping.test/";

describe("Agent principal scoping", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let pool: pg.Pool;
  let alice: string;
  let bob: string;
  let aliceClass: string;
  let bobClass: string;

  const admin = (method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: unknown) =>
    runtime.app.inject({
      method, url, headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** A roster read as the connector makes it: service token, plus the principal it verified. */
  const asAgent = (url: string, subject?: string) =>
    runtime.app.inject({
      method: "GET", url,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        ...(subject ? { "x-lorb-agent-issuer": ISSUER, "x-lorb-agent-subject": subject } : {}),
      },
    });

  const makeClass = async (token: string, name: string) => {
    const created = await admin("POST", "/api/v1/admin/classes", token, { name, year_group: "Year 9", subject: "Science" });
    expect(created.statusCode).toBe(201);
    const classId = created.json().class_id as string;
    await admin("POST", `/api/v1/admin/classes/${classId}/learners`, token, {
      learners: [{ learner_ref: `synthetic-${name.toLowerCase()}-01`, display_name: `${name} Learner` }],
    });
    return classId;
  };

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    runtime = await buildRuntime({
      iesKey: keys.publicKey, iesIssuer: IES, playerOrigin: "https://player.agent-scoping.test",
      secret: Buffer.alloc(32, 11), internalServiceToken: SERVICE_TOKEN,
    });
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // This suite asserts on which links exist, and the concurrent-claim case leaves one owned by
    // whichever teacher won. Without this, a second run against the same database inherits those
    // rows and fails on assertions that are actually correct.
    await pool.query("delete from agent_principal_link where agent_issuer = $1", [ISSUER]);
    alice = await issueIesToken(keys.privateKey as never, "synthetic-teacher-alice", "lorb-runtime", IES, { role: "admin" });
    bob = await issueIesToken(keys.privateKey as never, "synthetic-teacher-bob", "lorb-runtime", IES, { role: "admin" });
    aliceClass = await makeClass(alice, "AliceClass");
    bobClass = await makeClass(bob, "BobClass");
    await admin("POST", "/api/v1/admin/agent-links", alice, { agent_issuer: ISSUER, agent_subject: "auth0|alice", label: "Alice's assistant" });
  });

  afterAll(async () => {
    await pool.query("delete from agent_principal_link where agent_issuer = $1", [ISSUER]).catch(() => undefined);
    await runtime.app.close();
    await pool.end();
  });

  describe("fails closed", () => {
    it("serves no classes to a principal that is not linked", async () => {
      const response = await asAgent("/api/v1/internal/roster/classes", "auth0|nobody");
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([]);
    });

    it("serves no classes when no principal is presented at all", async () => {
      // The service token alone used to be enough. It must no longer be.
      const response = await asAgent("/api/v1/internal/roster/classes");
      expect(response.json().items).toEqual([]);
    });

    it("refuses every class-addressed read without a linked principal", async () => {
      for (const path of ["", "/recent-topics", "/roster"]) {
        expect((await asAgent(`/api/v1/internal/roster/classes/${aliceClass}${path}`)).statusCode).toBe(404);
        expect((await asAgent(`/api/v1/internal/roster/classes/${aliceClass}${path}`, "auth0|nobody")).statusCode).toBe(404);
      }
    });

    it("still refuses everything when the service token is wrong, linked or not", async () => {
      const response = await runtime.app.inject({
        method: "GET", url: "/api/v1/internal/roster/classes",
        headers: { authorization: "Bearer wrong", "x-lorb-agent-issuer": ISSUER, "x-lorb-agent-subject": "auth0|alice" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("scopes to the linked teacher", () => {
    it("lists that teacher's classes and nobody else's", async () => {
      const items = (await asAgent("/api/v1/internal/roster/classes", "auth0|alice")).json().items as Array<{ class_id: string }>;
      const ids = items.map((entry) => entry.class_id);
      expect(ids).toContain(aliceClass);
      expect(ids).not.toContain(bobClass);
    });

    it("refuses another teacher's class by direct UUID", async () => {
      // The exposure this whole change exists to close: knowing the UUID was previously enough.
      for (const path of ["", "/recent-topics", "/roster"]) {
        expect((await asAgent(`/api/v1/internal/roster/classes/${bobClass}${path}`, "auth0|alice")).statusCode).toBe(404);
      }
      expect((await asAgent(`/api/v1/internal/roster/classes/${aliceClass}`, "auth0|alice")).statusCode).toBe(200);
    });

    it("stops serving a class once the link is revoked", async () => {
      const revoke = await admin("DELETE", `/api/v1/admin/agent-links/${encodeURIComponent(ISSUER)}/${encodeURIComponent("auth0|alice")}`, alice);
      expect(revoke.statusCode).toBe(204);
      expect((await asAgent("/api/v1/internal/roster/classes", "auth0|alice")).json().items).toEqual([]);
      expect((await asAgent(`/api/v1/internal/roster/classes/${aliceClass}`, "auth0|alice")).statusCode).toBe(404);
      // Restore for any later test in this file.
      await admin("POST", "/api/v1/admin/agent-links", alice, { agent_issuer: ISSUER, agent_subject: "auth0|alice" });
    });
  });

  describe("a link only ever grants access to the linker's own classes", () => {
    it("refuses to re-point another teacher's live link", async () => {
      const response = await admin("POST", "/api/v1/admin/agent-links", bob, { agent_issuer: ISSUER, agent_subject: "auth0|alice" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("AGENT_LINK_TAKEN");
      // Alice's assistant must still see Alice's classes, not Bob's.
      const ids = ((await asAgent("/api/v1/internal/roster/classes", "auth0|alice")).json().items as Array<{ class_id: string }>).map((c) => c.class_id);
      expect(ids).toContain(aliceClass);
      expect(ids).not.toContain(bobClass);
    });

    it("lists only the caller's own links", async () => {
      const bobsLinks = (await admin("GET", "/api/v1/admin/agent-links", bob)).json().items as unknown[];
      expect(bobsLinks).toEqual([]);
      const alicesLinks = (await admin("GET", "/api/v1/admin/agent-links", alice)).json().items as Array<{ agent_subject: string }>;
      expect(alicesLinks.map((l) => l.agent_subject)).toContain("auth0|alice");
    });

    // Two teachers claiming the same unlinked principal at once. Both preliminary reads would see
    // no active row, so the ownership condition has to live in the write itself or the later
    // transaction silently takes the link the earlier one just won.
    it("lets only one of two concurrent claims win", async () => {
      const subject = `auth0|race-${randomUUID()}`;
      const [first, second] = await Promise.all([
        admin("POST", "/api/v1/admin/agent-links", alice, { agent_issuer: ISSUER, agent_subject: subject, label: "alice" }),
        admin("POST", "/api/v1/admin/agent-links", bob, { agent_issuer: ISSUER, agent_subject: subject, label: "bob" }),
      ]);
      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([201, 409]);
      // Exactly one live row, and the classes it grants belong to whichever teacher won.
      const rows = await pool.query(
        "select teacher_pseudonym from agent_principal_link where agent_issuer = $1 and agent_subject = $2 and revoked_at is null",
        [ISSUER, subject],
      );
      expect(rows.rowCount).toBe(1);
      const winner = first.statusCode === 201 ? aliceClass : bobClass;
      const loser = first.statusCode === 201 ? bobClass : aliceClass;
      const ids = ((await asAgent("/api/v1/internal/roster/classes", subject)).json().items as Array<{ class_id: string }>).map((c) => c.class_id);
      expect(ids).toContain(winner);
      expect(ids).not.toContain(loser);
    });

    // Fastify already decodes route parameters. Decoding them again turns a subject holding a
    // literal percent sequence into a different string, and its link becomes unrevocable.
    it("revokes a subject containing a percent sequence", async () => {
      const subject = "auth0|a%2Fb";
      expect((await admin("POST", "/api/v1/admin/agent-links", alice, { agent_issuer: ISSUER, agent_subject: subject })).statusCode).toBe(201);
      const revoke = await admin("DELETE", `/api/v1/admin/agent-links/${encodeURIComponent(ISSUER)}/${encodeURIComponent(subject)}`, alice);
      expect(revoke.statusCode).toBe(204);
      expect((await asAgent("/api/v1/internal/roster/classes", subject)).json().items).toEqual([]);
    });

    it("refuses to revoke a link the caller does not own", async () => {
      const response = await admin("DELETE", `/api/v1/admin/agent-links/${encodeURIComponent(ISSUER)}/${encodeURIComponent("auth0|alice")}`, bob);
      expect(response.statusCode).toBe(404);
      expect((await asAgent("/api/v1/internal/roster/classes", "auth0|alice")).json().items).not.toEqual([]);
    });
  });
});
