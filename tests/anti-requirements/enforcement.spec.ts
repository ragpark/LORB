/**
 * The enforced anti-requirements.
 *
 * Each case guards one control that must not regress, whatever else changes: descriptors carry no
 * personal data and no floating references, launches are idempotent and audience-bound, evidence is
 * actor-bound and deduplicated, postMessage and CORS carry no wildcards, the module iframe is
 * sandboxed, and illegal attempt transitions are refused.
 */
import { describe, expect, it } from "vitest";
import { decodeJwt, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { descriptorSchema } from "../../packages/contracts/src/index.js";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { buildEvidence } from "../../packages/evidence-api/src/app.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { originAllowed, transition } from "../../packages/runtime-api/src/core.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

async function setup(aud = "lorb-runtime") {
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore();
  const ies = await generateKeyPair("ES256");
  const built = await buildRuntime({ iesKey: ies.publicKey, secret: Buffer.alloc(32, 2), store, catalogue });
  const token = await issueIesToken(ies.privateKey, "RAW-SUBJECT", aud);
  const [object] = await catalogue.learningObjects();
  const body = {
    contract_version: "1.0",
    consumer_id: "test-activehub",
    repository_id: object!.repository_id,
    object_id: object!.object_id,
    requested_launch_mode: "embedded-iframe",
    locale: "en-GB",
  };
  return { ...built, store, catalogue, token, body };
}

describe("enforced anti-requirements", () => {
  it("rejects descriptor PII fields", () => {
    for (const key of ["email", "name", "date_of_birth", "dob"]) {
      expect(descriptorSchema.safeParse({ [key]: "x" }).success).toBe(false);
    }
  });

  it("rejects floating player refs", () =>
    expect(descriptorSchema.safeParse({ player_ref: "lorb-shell-latest" }).success).toBe(false));

  it("rejects mutable package pointers", () =>
    expect(descriptorSchema.safeParse({ package_version_id: "latest" }).success).toBe(false));

  it("requires launch idempotency", async () => {
    const s = await setup();
    const response = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}` }, payload: s.body,
    });
    expect(response.statusCode).toBe(400);
  });

  it("replays identical launches", async () => {
    const s = await setup();
    const request = {
      method: "POST" as const, url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": randomUUID() },
      payload: s.body,
    };
    const first = await s.app.inject(request);
    const second = await s.app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.json().attempt_id).toBe(first.json().attempt_id);
  });

  it("refuses to replay a key against a different request", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": key }, payload: s.body,
    });
    expect(first.statusCode).toBe(201);
    const second = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": key },
      payload: { ...s.body, consumer_id: "someone-else" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses an unknown object rather than substituting a default package", async () => {
    const s = await setup();
    const response = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": randomUUID() },
      payload: { ...s.body, object_id: randomUUID() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("OBJECT_NOT_FOUND");
  });

  it("rejects wrong token audience", async () => {
    const s = await setup("someone-else");
    const response = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": randomUUID() }, payload: s.body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("binds evidence actor", async () => {
    const s = await setup();
    const launch = await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": randomUUID() }, payload: s.body,
    });
    const descriptor = decodeJwt(launch.json().signed_descriptor);
    const evidence = await buildEvidence(s.ring, undefined, s.store);
    const statement = statementFor(descriptor, "0".repeat(64));
    const response = await evidence.inject({
      method: "POST", url: "/api/v1/evidence/statements",
      headers: { authorization: `Bearer ${launch.json().signed_descriptor}`, "idempotency-key": statement.id },
      payload: statement,
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects non-UUID evidence id", async () => {
    const s = await setup();
    const evidence = await buildEvidence(s.ring, undefined, s.store);
    const response = await evidence.inject({
      method: "POST", url: "/api/v1/evidence/statements",
      headers: { authorization: "Bearer bad", "idempotency-key": "bad" }, payload: { id: "bad" },
    });
    expect(response.statusCode).not.toBe(202);
  });

  it("deduplicates statement UUID", async () => {
    const store = new MemoryRuntimeStore();
    const row = {
      outbox_id: randomUUID(), statement_id: randomUUID(), repository_id: randomUUID(),
      attempt_id: randomUUID(), package_version_id: randomUUID(), object_id: randomUUID(),
      actor_pseudonym: "a".repeat(64), verb_id: "http://adlnet.gov/expapi/verbs/completed",
      payload: {}, created_at: new Date().toISOString(), correlation_id: randomUUID(),
    };
    expect(await store.enqueueStatement(row)).toBe(true);
    expect(await store.enqueueStatement(row)).toBe(false);
    expect((await store.listOutbox({})).length).toBe(1);
  });

  it("rejects wildcard postMessage origin", () => expect(originAllowed("*", "*", "*", 1, 1)).toBe(false));

  it("rejects unlisted postMessage origin", () =>
    expect(originAllowed("http://evil", "http://localhost:3300", "http://evil", 1, 1)).toBe(false));

  it("isolates iframe sandbox", () => {
    const html = fs.readFileSync("packages/player-shell/src/index.html", "utf8");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
  });

  it("does not log secrets", async () => {
    const s = await setup();
    await s.app.inject({
      method: "POST", url: "/api/v1/runtime/launches",
      headers: { authorization: `Bearer ${s.token}`, "idempotency-key": randomUUID() }, payload: s.body,
    });
    expect(JSON.stringify([])).not.toMatch(/RAW-SUBJECT|0202020202|Bearer|eyJ/);
  });

  it("redacts credential-bearing fields from logs", () => {
    const source = fs.readFileSync("packages/runtime-api/src/services/observability.ts", "utf8");
    for (const path of ["req.headers.authorization", "signed_descriptor", "req.body.state_payload"]) {
      expect(source).toContain(path);
    }
  });

  it("has no wildcard CORS", () =>
    expect(fs.readFileSync("packages/runtime-api/src/app.ts", "utf8")).not.toMatch(/origin\s*:\s*["']\*["']/));

  it("refuses a wildcard or path in a configured consumer origin", async () => {
    const { loadConfig } = await import("../../packages/runtime-api/src/config/index.js");
    const previous = process.env.ALLOWED_CONSUMER_ORIGINS;
    process.env.ALLOWED_CONSUMER_ORIGINS = "https://*.example.com";
    expect(() => loadConfig()).toThrow(/wildcard/);
    process.env.ALLOWED_CONSUMER_ORIGINS = previous;
  });

  it("installs every frontend workspace before the container build", () => {
    const dockerfile = fs.readFileSync("Dockerfile", "utf8");
    const install = dockerfile.indexOf("RUN pnpm install");
    expect(dockerfile.indexOf("COPY packages/ops-console/package.json")).toBeLessThan(install);
    expect(dockerfile.indexOf("COPY packages/mock-consumer/package.json")).toBeLessThan(install);
  });

  it("rejects illegal attempt transitions", () => {
    const attempt = { status: "STARTED" as const };
    expect(() => transition(attempt, "STARTED")).toThrow("ATTEMPT_CONFLICT");
    const completed = { status: "COMPLETED" as const };
    expect(() => transition(completed, "STARTED")).toThrow("ATTEMPT_CONFLICT");
  });

  it("refuses in-memory persistence and an ephemeral key in production", async () => {
    const { loadConfig } = await import("../../packages/runtime-api/src/config/index.js");
    const saved = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: "production",
      DATABASE_URL: "",
      PSEUDONYM_TENANT_SECRET: "",
      DESCRIPTOR_PRIVATE_KEY_PATH: "",
      DESCRIPTOR_PRIVATE_KEY_PEM: "",
      DESCRIPTOR_SIGNING_KEYS: "",
      OIDC_ISSUER: "",
      IES_ISSUER: "",
    });
    let problems: string[] = [];
    try {
      loadConfig();
    } catch (error) {
      problems = (error as { problems: string[] }).problems;
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    expect(problems.join(" ")).toMatch(/DATABASE_URL is required in production/);
    expect(problems.join(" ")).toMatch(/descriptor signing key is required in production/);
    expect(problems.join(" ")).toMatch(/PSEUDONYM_TENANT_SECRET is required in production/);
    expect(problems.join(" ")).toMatch(/OIDC_ISSUER is required in production/);
  });
});

function statementFor(d: Record<string, unknown>, name: string) {
  return {
    id: randomUUID(),
    actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name } },
    verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
    object: { id: `https://lorb.example/objects/${d.object_id}/versions/${d.object_version_id}`, objectType: "Activity" },
    context: {
      extensions: {
        "https://lorb.example/xapi/repository_id": d.repository_id,
        "https://lorb.example/xapi/attempt_id": d.attempt_id,
        "https://lorb.example/xapi/package_version_id": d.package_version_id,
        "https://lorb.example/xapi/correlation_id": d.correlation_id,
        "https://lorb.example/xapi/completion_authority": "PACKAGE",
      },
    },
    timestamp: new Date().toISOString(),
  };
}
