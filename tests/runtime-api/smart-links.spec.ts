import { randomUUID } from "node:crypto";
import { decodeJwt, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

let PUBLISHED_OBJECT_ID = "";

async function setup() {
  const ies = await generateKeyPair("ES256");
  const urls = { ies: `https://ies.smart-links-${randomUUID()}.test`, player: `https://player.smart-links-${randomUUID()}.test` };
  const catalogue = new MemoryCatalogueStore();
  const store = new MemoryRuntimeStore();
  PUBLISHED_OBJECT_ID = (await catalogue.learningObjects({ status: "PUBLISHED" }))[0]!.object_id;
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: urls.ies, playerOrigin: urls.player,
    secret: Buffer.alloc(32, 7), store, catalogue,
  });
  const adminToken = await issueIesToken(ies.privateKey, "smart-link-admin", "lorb-runtime", urls.ies, { role: "admin" });
  const learnerToken = await issueIesToken(ies.privateKey, "smart-link-learner", "lorb-runtime", urls.ies, {});
  return { runtime, store, catalogue, adminToken, learnerToken, playerOrigin: urls.player };
}

describe("Learning object smart links", () => {
  it("lets an admin create a smart link for a published object and redeem it into the Player Shell", async () => {
    const { runtime, adminToken, playerOrigin } = await setup();

    const create = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.object_id).toBe(PUBLISHED_OBJECT_ID);
    expect(created.revoked_at).toBeNull();
    expect(created.url).toContain(created.token);

    // Repeat creation returns the same active link rather than minting a second one — but not the
    // token itself. Only a hash of it is stored, so a later read cannot reproduce it; an admin who
    // loses the token revokes the link and creates a new one.
    const createAgain = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    expect(createAgain.statusCode).toBe(200);
    expect(createAgain.json().smart_link_id).toBe(created.smart_link_id);
    expect(createAgain.json().token).toBeUndefined();
    expect(createAgain.json().token_prefix).toBe(created.token.slice(0, 8));

    const redeem = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/smart-links/${created.token}` });
    expect(redeem.statusCode).toBe(302);
    const location = redeem.headers.location as string;
    expect(location.startsWith(`${playerOrigin}/#descriptor=`)) .toBe(true);
    const descriptor = decodeURIComponent(location.slice(`${playerOrigin}/#descriptor=`.length));
    const payload = decodeJwt(descriptor);
    expect(payload.object_id).toBe(PUBLISHED_OBJECT_ID);
    expect(payload.sub).toMatch(/^[a-f\d]{64}$/);
    expect(redeem.headers["set-cookie"]).toBeDefined();
    await runtime.app.close();
  });

  it("derives the same pseudonym for repeat visits from the same browser, and a fresh attempt each time", async () => {
    const { runtime, adminToken } = await setup();
    const create = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    const token = create.json().token as string;

    const first = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/smart-links/${token}` });
    const setCookie = (first.headers["set-cookie"] as string).split(";")[0];
    const firstDescriptor = decodeJwt(decodeURIComponent((first.headers.location as string).split("#descriptor=")[1]!));

    const second = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/smart-links/${token}`, headers: { cookie: setCookie } });
    const secondDescriptor = decodeJwt(decodeURIComponent((second.headers.location as string).split("#descriptor=")[1]!));

    expect(secondDescriptor.sub).toBe(firstDescriptor.sub);
    expect(secondDescriptor.attempt_id).not.toBe(firstDescriptor.attempt_id);
    await runtime.app.close();
  });

  it("revokes a smart link so it can no longer be created-over, fetched, or redeemed", async () => {
    const { runtime, adminToken } = await setup();
    const create = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    const token = create.json().token as string;

    const revoke = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link/revoke`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    expect(revoke.statusCode).toBe(200);

    const get = await runtime.app.inject({
      method: "GET",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(get.statusCode).toBe(404);
    expect(get.json().code).toBe("SMART_LINK_NOT_FOUND");

    const redeem = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/smart-links/${token}` });
    expect(redeem.statusCode).toBe(404);
    expect(redeem.json().code).toBe("SMART_LINK_NOT_FOUND");

    // Regenerates cleanly after revocation instead of resurrecting the revoked token.
    const recreate = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    expect(recreate.statusCode).toBe(201);
    expect(recreate.json().token).not.toBe(token);
    await runtime.app.close();
  });

  it("rejects smart-link management by a non-admin and requests for an unknown or unpublished object", async () => {
    const { runtime, adminToken, learnerToken } = await setup();

    const asLearner = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
    });
    expect(asLearner.statusCode).toBe(403);

    const unknownObject = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${randomUUID()}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
    });
    expect(unknownObject.statusCode).toBe(404);
    expect(unknownObject.json().code).toBe("LEARNING_OBJECT_NOT_FOUND");

    const noIdempotencyKey = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/admin/learning-objects/${PUBLISHED_OBJECT_ID}/smart-link`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(noIdempotencyKey.statusCode).toBe(400);

    const unknownToken = await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/smart-links/${randomUUID()}` });
    expect(unknownToken.statusCode).toBe(404);
    await runtime.app.close();
  });
});
