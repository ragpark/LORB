/**
 * The deployed-equivalent flow: independently HTTPS-terminated identity, runtime, player and
 * evidence origins, with the descriptor verified against the published JWKS rather than a key the
 * test happens to hold.
 */
import { randomUUID } from "node:crypto";
import { createLocalJWKSet, decodeJwt, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

it("runs the deployed-equivalent identity to player completion flow with public origins", async () => {
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore();
  const ies = await generateKeyPair("ES256");
  const urls = {
    ies: "https://ies.example.test",
    runtime: "https://runtime.example.test",
    player: "https://player.example.test",
    evidence: "https://evidence.example.test/api/v1/evidence/statements",
  };
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: urls.ies, publicIssuer: urls.runtime,
    playerOrigin: urls.player, evidenceEndpoint: urls.evidence,
    secret: Buffer.alloc(32, 9), store, catalogue,
  });
  const [object] = await catalogue.learningObjects();
  const accessToken = await issueIesToken(ies.privateKey, "deployed-learner", "lorb-runtime", urls.ies);

  const launch = await runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${accessToken}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "deployed-consumer",
      repository_id: object!.repository_id, object_id: object!.object_id,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(launch.statusCode).toBe(201);
  const response = launch.json();
  expect(response.player_url).toMatch(/^https:\/\/player\.example\.test\/#descriptor=/);

  // A relying party verifies against the published JWKS, which is what makes a descriptor issued by
  // one replica verifiable by another.
  const jwks = await runtime.app.inject({ method: "GET", url: "/api/v1/runtime/jwks" });
  const verified = await jwtVerify(response.signed_descriptor, createLocalJWKSet(jwks.json()), {
    issuer: urls.runtime, audience: "lorb-player", algorithms: ["ES256"],
  });
  expect(verified.payload.iss).toBe(urls.runtime);

  const descriptor = decodeJwt(response.signed_descriptor);
  expect(descriptor).toMatchObject({
    iss: urls.runtime,
    evidence_endpoint: urls.evidence,
    package_url: `${urls.player}${object!.module_path}`,
  });
  expect(descriptor.state_endpoint).toBe(`${urls.runtime}/api/v1/runtime/attempts/${response.attempt_id}/state`);

  const state = await runtime.app.inject({
    method: "PUT", url: `/api/v1/runtime/attempts/${response.attempt_id}/state`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
    payload: { revision: 1, state_payload: { page: 2 } },
  });
  expect(state.statusCode).toBe(200);

  // A second write at the revision already consumed is refused rather than overwriting.
  const stale = await runtime.app.inject({
    method: "PUT", url: `/api/v1/runtime/attempts/${response.attempt_id}/state`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
    payload: { revision: 1, state_payload: { page: 3 } },
  });
  expect(stale.statusCode).toBe(409);

  const complete = await runtime.app.inject({
    method: "POST", url: `/api/v1/runtime/attempts/${response.attempt_id}/complete`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
  });
  expect(complete.statusCode).toBe(200);
  expect((await store.getAttempt(response.attempt_id))?.status).toBe("COMPLETED");

  // Completing twice is a conflict, not a second completion.
  const again = await runtime.app.inject({
    method: "POST", url: `/api/v1/runtime/attempts/${response.attempt_id}/complete`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
  });
  expect(again.statusCode).toBe(409);

  await runtime.app.close();
});
