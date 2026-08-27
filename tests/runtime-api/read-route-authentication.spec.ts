/**
 * The runtime read surface is not anonymous.
 *
 * The catalogue names every repository and learning object a deployment holds, and the attempt
 * records carry learner pseudonyms and stored state payloads. Before these tests existed, all of it
 * was served to anyone who knew the URL. The contract now: catalogue reads require any subject the
 * identity provider vouches for (the same bar as launching), attempt reads require an administrator,
 * and the routes a sandboxed launch itself calls — content, jwks — stay public, because the module
 * runs from an opaque origin holding a descriptor rather than a bearer token.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const ISSUER = "https://ies.read-auth.test";

describe("runtime read-route authentication", () => {
  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  let learnerToken: string;
  let adminToken: string;
  let objectId: string;

  beforeAll(async () => {
    process.env.ADMIN_ALLOWED_ROLES = "admin";
    const keys = await generateKeyPair("ES256");
    const catalogue = new MemoryCatalogueStore();
    runtime = await buildRuntime({
      iesKey: keys.publicKey as never,
      iesIssuer: ISSUER,
      secret: Buffer.alloc(32, 5),
      store: new MemoryRuntimeStore(),
      catalogue,
    });
    learnerToken = await issueIesToken(keys.privateKey as never, "read-auth-learner", "lorb-runtime", ISSUER, {});
    adminToken = await issueIesToken(keys.privateKey as never, "read-auth-admin", "lorb-runtime", ISSUER, { role: "admin" });
    // A quiz carries authored content, so the public content route has a real body to serve.
    const quiz = await catalogue.registerQuiz({
      title: "Read-auth quiz",
      subject: "Science",
      year_group: "Year 9",
      questions: [{ stem: "Which gas do plants take in?", options: [{ id: "a", text: "Carbon dioxide" }, { id: "b", text: "Nitrogen" }], correct_option_id: "a" }],
    });
    objectId = quiz.object_id;
  });

  afterAll(async () => {
    await runtime.app.close();
  });

  const get = (url: string, token?: string) =>
    runtime.app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it.each([
    "/api/v1/runtime/repositories",
    "/api/v1/runtime/learning-objects",
    "/api/v1/runtime/package-versions",
  ])("refuses %s without a token and serves it to any signed-in subject", async (url) => {
    const anonymous = await get(url);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe("AUTHENTICATION_EXPIRED");

    const signedIn = await get(url, learnerToken);
    expect(signedIn.statusCode).toBe(200);
    expect(Array.isArray(signedIn.json().items)).toBe(true);
  });

  it("refuses catalogue detail routes without a token", async () => {
    expect((await get(`/api/v1/runtime/learning-objects/${objectId}`)).statusCode).toBe(401);
    expect((await get(`/api/v1/runtime/repositories/${randomUUID()}`)).statusCode).toBe(401);
    expect((await get(`/api/v1/runtime/package-versions/${randomUUID()}`)).statusCode).toBe(401);
    expect((await get(`/api/v1/runtime/learning-objects/${objectId}`, learnerToken)).statusCode).toBe(200);
  });

  it("refuses a forged token outright", async () => {
    const other = await generateKeyPair("ES256");
    const forged = await issueIesToken(other.privateKey as never, "read-auth-forger", "lorb-runtime", ISSUER, {});
    expect((await get("/api/v1/runtime/learning-objects", forged)).statusCode).toBe(401);
  });

  it("serves attempts to an administrator only", async () => {
    expect((await get("/api/v1/runtime/attempts")).statusCode).toBe(401);
    // A signed-in learner is still not an administrator: the record set spans other learners.
    expect((await get("/api/v1/runtime/attempts", learnerToken)).statusCode).toBe(403);
    expect((await get(`/api/v1/runtime/attempts/${randomUUID()}`, learnerToken)).statusCode).toBe(403);

    const admin = await get("/api/v1/runtime/attempts", adminToken);
    expect(admin.statusCode).toBe(200);
    expect(Array.isArray(admin.json().items)).toBe(true);
  });

  it("keeps the launch-critical routes public", async () => {
    // The sandboxed module fetches content with no bearer token — only its descriptor names the
    // version. Authenticating this route breaks every quiz in the deployed topology.
    expect((await get(`/api/v1/runtime/learning-objects/${objectId}/content`)).statusCode).toBe(200);
    expect((await get("/api/v1/runtime/jwks")).statusCode).toBe(200);
  });
});
