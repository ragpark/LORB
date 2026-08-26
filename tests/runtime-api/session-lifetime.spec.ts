/**
 * One lifetime, not two.
 *
 * The descriptor's `exp` came from DESCRIPTOR_TTL_SECONDS while the attempt's `expires_at` — the
 * value reported to the caller and stored on the attempt — was a hard-coded ten minutes. Configure a
 * shorter lifetime and the player is told its session is good for longer than its credential will be
 * accepted; configure a longer one and attempt maintenance can expire a session whose descriptor a
 * learner is still holding. Neither failure is visible until it happens to somebody mid-activity.
 */
import { randomUUID } from "node:crypto";
import { decodeJwt, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const ISSUER = "https://identity.lifetime.test";

afterEach(() => {
  delete process.env.DESCRIPTOR_TTL_SECONDS;
});

async function launchOnce() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore();
  const runtime = await buildRuntime({ iesKey: keys.publicKey, iesIssuer: ISSUER, secret: Buffer.alloc(32, 3), store, catalogue });
  const [object] = await catalogue.learningObjects();
  const token = await issueIesToken(keys.privateKey, "learner-lifetime", "lorb-runtime", ISSUER);

  const response = await runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "lifetime-suite",
      repository_id: object!.repository_id, object_id: object!.object_id,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  const attempt = await store.getAttempt(body.attempt_id);
  await runtime.app.close();
  return { body, attempt: attempt!, descriptor: decodeJwt(body.signed_descriptor) };
}

describe("attempt expiry follows the configured descriptor lifetime", () => {
  it("agrees with the descriptor at the default lifetime", async () => {
    const { body, attempt, descriptor } = await launchOnce();
    // Within a second: the two are computed from different clock reads in the same request.
    expect(Math.abs(Date.parse(body.expires_at) / 1000 - descriptor.exp!)).toBeLessThanOrEqual(1);
    expect(attempt.expires_at).toBe(body.expires_at);
  });

  it("follows a configured lifetime shorter than the default", async () => {
    process.env.DESCRIPTOR_TTL_SECONDS = "120";
    const { body, descriptor } = await launchOnce();
    expect(Math.abs(Date.parse(body.expires_at) / 1000 - descriptor.exp!)).toBeLessThanOrEqual(1);
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThan(150_000);
  });

  it("follows a configured lifetime longer than the default", async () => {
    process.env.DESCRIPTOR_TTL_SECONDS = "900";
    const { body, descriptor } = await launchOnce();
    expect(Math.abs(Date.parse(body.expires_at) / 1000 - descriptor.exp!)).toBeLessThanOrEqual(1);
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(700_000);
  });
});
