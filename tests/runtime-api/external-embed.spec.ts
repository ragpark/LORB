/**
 * External embed: a plain iframe embed of a third party's page, for content that speaks no launch
 * protocol at all — not LTI, not the module postMessage handshake. Weaker than an lti-tool launch by
 * design: no signed launch, no verification of the embedded page's identity. The only guardrail is
 * that `embed_url`'s origin must already be on the deployment's configured
 * ALLOWED_EXTERNAL_EMBED_ORIGINS allow-list — an admin cannot point a launch at an origin nobody at
 * the deployment level agreed to trust, mirroring the reasoning behind native-web-package's own
 * module_path invariant.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { externalEmbedDraftSchema } from "../../packages/contracts/src/index.js";

const ISSUER = "https://identity.external-embed.test";
const TRUSTED_ORIGIN = "https://trusted-tool.example.com";

async function setup(allowedOrigins: string[] = [TRUSTED_ORIGIN]) {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore({ seedExamples: false });
  const runtime = await buildRuntime({
    iesKey: keys.publicKey, iesIssuer: ISSUER, playerOrigin: `https://player.external-embed-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 17), store, catalogue, allowedExternalEmbedOrigins: allowedOrigins,
  });
  const adminToken = await issueIesToken(keys.privateKey, "embed-admin", "lorb-runtime", ISSUER, { role: "admin" });
  const learnerToken = await issueIesToken(keys.privateKey, "embed-learner", "lorb-runtime", ISSUER, {});
  const repository = (await catalogue.defaultRepository())!;

  const call = (method: "GET" | "POST", url: string, payload?: unknown, as = adminToken) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { runtime, store, catalogue, call, adminToken, learnerToken, repositoryId: repository.repository_id };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  title: "Trusted interactive activity",
  description: "A page hosted by a trusted partner.",
  embed_url: `${TRUSTED_ORIGIN}/activity`,
  ...overrides,
});

describe("External embed draft contract", () => {
  it("refuses a non-https embed_url", () => {
    expect(externalEmbedDraftSchema.safeParse(draft({ embed_url: "http://trusted-tool.example.com/activity" })).success).toBe(false);
  });
  it("accepts a well-formed draft", () => {
    expect(externalEmbedDraftSchema.safeParse(draft()).success).toBe(true);
  });
});

describe("External embed registration", () => {
  it("registers an embed whose origin is on the allow-list, PUBLISHED and previewable", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/external-embeds", { repository_id: repositoryId, ...draft() });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.object_id).toBeTruthy();

    const preview = await call("GET", `/api/v1/admin/learning-objects/${body.object_id}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().kind).toBe("external-embed");
    expect(preview.json().embed_url).toBe(`${TRUSTED_ORIGIN}/activity`);
  });

  it("refuses an embed_url whose origin is not on the allow-list", async () => {
    const { call, repositoryId } = await setup();
    const response = await call("POST", "/api/v1/publisher/learning-objects/external-embeds", {
      repository_id: repositoryId, ...draft({ embed_url: "https://untrusted.example.com/activity" }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("EXTERNAL_EMBED_ORIGIN_NOT_ALLOWED");
  });

  it("refuses every origin when no allow-list is configured", async () => {
    const { call, repositoryId } = await setup([]);
    const response = await call("POST", "/api/v1/publisher/learning-objects/external-embeds", { repository_id: repositoryId, ...draft() });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("EXTERNAL_EMBED_ORIGIN_NOT_ALLOWED");
  });

  it("refuses registration from a non-admin caller", async () => {
    const { call, repositoryId, learnerToken } = await setup();
    const response = await call("POST", "/api/v1/publisher/learning-objects/external-embeds", { repository_id: repositoryId, ...draft() }, learnerToken);
    expect(response.statusCode).toBe(403);
  });

  it("never touches the native-web-package module_path invariant", async () => {
    const { call, repositoryId } = await setup();
    const created = await call("POST", "/api/v1/publisher/learning-objects/external-embeds", { repository_id: repositoryId, ...draft() });
    expect(created.json()).not.toHaveProperty("module_path");
  });
});
