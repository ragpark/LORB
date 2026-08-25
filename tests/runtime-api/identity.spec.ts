/**
 * Token verification through a published JWKS.
 *
 * Every other suite injects the identity provider's public key straight into the runtime, which is
 * convenient and skips the step a real deployment actually performs: fetching the key set and
 * resolving by the `kid` the token names. A provider whose issuer stamps one `kid` while its JWKS
 * publishes another passes every injected-key test and rejects every real request with a 401 that
 * reads like an expiry — which is exactly what happened here.
 */
import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { DEV_IDENTITY_KID, issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { devJwks } from "../../packages/dev-identity/src/jwks.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const ISSUER = "https://identity.jwks.test";

async function setup() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const catalogue = new MemoryCatalogueStore();
  // Resolved the way a deployment resolves it: through the key set the provider publishes.
  const jwks = createLocalJWKSet(devJwks(await exportJWK(keys.publicKey)));
  const runtime = await buildRuntime({
    identityKeys: jwks as never,
    iesIssuer: ISSUER,
    secret: Buffer.alloc(32, 5),
    store: new MemoryRuntimeStore(),
    catalogue,
  });
  const [object] = await catalogue.learningObjects();
  return { runtime, keys, catalogue, object: object! };
}

const launch = (runtime: Awaited<ReturnType<typeof setup>>["runtime"], token: string, object: { repository_id: string; object_id: string }) =>
  runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "jwks-suite",
      repository_id: object.repository_id, object_id: object.object_id,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });

describe("identity verification through a published key set", () => {
  it("accepts a token whose kid the key set publishes", async () => {
    const { runtime, keys, object } = await setup();
    const token = await issueIesToken(keys.privateKey, "learner-1", "lorb-runtime", ISSUER);
    const response = await launch(runtime, token, object);
    expect(response.statusCode).toBe(201);
    await runtime.app.close();
  });

  it("publishes the same kid the issuer stamps", async () => {
    const { keys } = await setup();
    const token = await issueIesToken(keys.privateKey, "learner-1", "lorb-runtime", ISSUER);
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    const published = devJwks(await exportJWK(keys.publicKey)).keys.map((key) => key.kid);
    expect(header.kid).toBe(DEV_IDENTITY_KID);
    expect(published).toContain(header.kid);
  });

  it("refuses a token signed by a key the set does not publish", async () => {
    const { runtime, object } = await setup();
    const other = await generateKeyPair("ES256", { extractable: true });
    const token = await issueIesToken(other.privateKey, "learner-1", "lorb-runtime", ISSUER);
    const response = await launch(runtime, token, object);
    expect(response.statusCode).toBe(401);
    await runtime.app.close();
  });

  it("refuses a token from a different issuer", async () => {
    const { runtime, keys, object } = await setup();
    const token = await issueIesToken(keys.privateKey, "learner-1", "lorb-runtime", "https://elsewhere.test");
    expect((await launch(runtime, token, object)).statusCode).toBe(401);
    await runtime.app.close();
  });

  it("refuses a token minted for a different audience", async () => {
    const { runtime, keys, object } = await setup();
    const token = await issueIesToken(keys.privateKey, "learner-1", "some-other-api", ISSUER);
    expect((await launch(runtime, token, object)).statusCode).toBe(401);
    await runtime.app.close();
  });

  it("reads the administrator role from the configured claim, in either shape providers emit", async () => {
    const { runtime, keys } = await setup();
    const asString = await issueIesToken(keys.privateKey, "admin-1", "lorb-runtime", ISSUER, { role: "admin" });
    const asArray = await issueIesToken(keys.privateKey, "admin-2", "lorb-runtime", ISSUER, { role: ["teacher", "admin"] });
    const asLearner = await issueIesToken(keys.privateKey, "learner-2", "lorb-runtime", ISSUER);

    const whoami = (token: string) =>
      runtime.app.inject({ method: "GET", url: "/api/v1/admin/whoami", headers: { authorization: `Bearer ${token}` } });

    expect((await whoami(asString)).statusCode).toBe(200);
    expect((await whoami(asArray)).statusCode).toBe(200);
    // A learner's token is valid and carries no administrator role: 403, not 401.
    expect((await whoami(asLearner)).statusCode).toBe(403);
    await runtime.app.close();
  });

  it("identifies an administrator by pseudonym, never by the subject the provider issued", async () => {
    const { runtime, keys } = await setup();
    const token = await issueIesToken(keys.privateKey, "a-very-identifiable-subject", "lorb-runtime", ISSUER, { role: "admin" });
    const response = await runtime.app.inject({
      method: "GET", url: "/api/v1/admin/whoami", headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json().pseudonym).toMatch(/^[a-f\d]{64}$/);
    expect(response.body).not.toContain("a-very-identifiable-subject");
    await runtime.app.close();
  });
});
