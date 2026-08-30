/**
 * Marketplace listing: whether a publisher has opted an object in to cross-repository discovery
 * (GET /api/v1/admin/marketplace), and toggling that flag through the publisher surface. Neither
 * needs a real Postgres administration database — both work against the in-memory catalogue, the
 * same as the rest of the publisher-media suite. Bookmarking a listed object into another
 * administrator's own assignable set (POST /api/v1/admin/marketplace/imports) does need Postgres,
 * since the bookmark lives in a roster-adjacent table — that is covered separately in
 * tests/runtime-api/marketplace-import.spec.ts.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

async function setup() {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.marketplace-listing-${randomUUID()}.test`;
  const catalogue = new MemoryCatalogueStore({ seedExamples: true });
  const store = new MemoryRuntimeStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.marketplace-listing-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 9), store, catalogue,
  });
  const token = await issueIesToken(ies.privateKey, "marketplace-admin", "lorb-runtime", issuer, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "marketplace-learner", "lorb-runtime", issuer, {});
  const objects = await catalogue.learningObjects({ status: "PUBLISHED" });

  const call = (method: "GET" | "PUT", url: string, payload?: unknown, as = token) =>
    runtime.app.inject({
      method, url,
      headers: { authorization: `Bearer ${as}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  return { runtime, catalogue, call, objectId: objects[0]!.object_id, learnerToken };
}

describe("marketplace listing", () => {
  it("is unlisted by default, and does not appear on the marketplace", async () => {
    const { runtime, call } = await setup();
    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    expect(marketplace.statusCode).toBe(200);
    expect(marketplace.json().items).toEqual([]);
    await runtime.app.close();
  });

  it("lets a repository operator list an object, and it appears on the marketplace with its publisher name", async () => {
    const { runtime, catalogue, call, objectId } = await setup();
    const listed = await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/marketplace-listing`, { listed: true });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().marketplace_listed).toBe(true);

    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    const items = marketplace.json().items as Array<{ object_id: string; publisher_name: string }>;
    expect(items.map((item) => item.object_id)).toContain(objectId);
    const repository = await catalogue.defaultRepository();
    expect(items.find((item) => item.object_id === objectId)?.publisher_name).toBe(repository?.display_name);
    await runtime.app.close();
  });

  it("removes an object from the marketplace when unlisted again", async () => {
    const { runtime, call, objectId } = await setup();
    await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/marketplace-listing`, { listed: true });
    const unlisted = await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/marketplace-listing`, { listed: false });
    expect(unlisted.statusCode).toBe(200);
    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    expect((marketplace.json().items as Array<{ object_id: string }>).map((item) => item.object_id)).not.toContain(objectId);
    await runtime.app.close();
  });

  it("refuses a non-admin caller, and lists nothing", async () => {
    const { runtime, call, objectId, learnerToken } = await setup();
    const response = await call("PUT", `/api/v1/publisher/learning-objects/${objectId}/marketplace-listing`, { listed: true }, learnerToken);
    expect(response.statusCode).toBe(403);
    const marketplace = await call("GET", "/api/v1/admin/marketplace");
    expect(marketplace.json().items).toEqual([]);
    await runtime.app.close();
  });
});
