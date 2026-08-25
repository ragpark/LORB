/**
 * Descriptor signing keys.
 *
 * The property that matters operationally is the one a per-process keypair could not offer: a
 * descriptor issued before a restart, a rotation, or by another replica still verifies. So the ring
 * publishes every key a relying party may still need, signs with exactly one, and resolves
 * verification by the `kid` the token names rather than probing.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueDescriptor, SigningKeyRing, verifyDescriptor } from "../../packages/runtime-api/src/core.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const pem = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ISSUER = "https://runtime.keys.test";
const claims = (attemptId = randomUUID()) => ({
  sub: "a".repeat(64),
  repository_id: randomUUID(),
  consumer_id: "keys-suite",
  object_id: randomUUID(),
  object_version_id: randomUUID(),
  package_version_id: randomUUID(),
  correlation_id: randomUUID(),
  locale: "en-GB",
  attempt_id: attemptId,
  state_endpoint: `${ISSUER}/api/v1/runtime/attempts/${attemptId}/state`,
  package_url: "https://player.keys.test/module/index.html",
  session_config: { expires_at: new Date(Date.now() + 600000).toISOString() },
});

const config = { issuer: ISSUER, evidenceEndpoint: `${ISSUER}/api/v1/evidence/statements` };

describe("descriptor signing key ring", () => {
  it("signs with the active key and names it in the header", async () => {
    const ring = await SigningKeyRing.fromConfig([{ kid: "key-a", pem: pem(), state: "ACTIVE" }]);
    const token = await issueDescriptor(ring, claims(), config);
    expect(decodeProtectedHeader(token).kid).toBe("key-a");
    expect(decodeProtectedHeader(token).typ).toBe("lorb-launch+jwt");
    await expect(verifyDescriptor(token, ring, ISSUER)).resolves.toBeTruthy();
  });

  it("keeps verifying a descriptor signed by the key that is now retiring", async () => {
    const previous = pem();
    const before = await SigningKeyRing.fromConfig([{ kid: "key-old", pem: previous, state: "ACTIVE" }]);
    const inFlight = await issueDescriptor(before, claims(), config);

    // The rotation window: a new ACTIVE key signs, the previous one stays in the ring to verify.
    const after = await SigningKeyRing.fromConfig([
      { kid: "key-new", pem: pem(), state: "ACTIVE" },
      { kid: "key-old", pem: previous, state: "RETIRING" },
    ]);
    await expect(verifyDescriptor(inFlight, after, ISSUER)).resolves.toBeTruthy();
    expect(decodeProtectedHeader(await issueDescriptor(after, claims(), config)).kid).toBe("key-new");
  });

  it("refuses a descriptor signed by a key that has left the ring", async () => {
    const before = await SigningKeyRing.fromConfig([{ kid: "key-old", pem: pem(), state: "ACTIVE" }]);
    const orphaned = await issueDescriptor(before, claims(), config);
    const after = await SigningKeyRing.fromConfig([{ kid: "key-new", pem: pem(), state: "ACTIVE" }]);
    await expect(verifyDescriptor(orphaned, after, ISSUER)).rejects.toThrow();
  });

  it("publishes every key in the ring so a relying party can verify either", async () => {
    const ring = await SigningKeyRing.fromConfig([
      { kid: "key-new", pem: pem(), state: "ACTIVE" },
      { kid: "key-old", pem: pem(), state: "RETIRING" },
    ]);
    const kids = ring.jwks().keys.map((key) => key.kid);
    expect(kids).toEqual(["key-new", "key-old"]);
    // Public material only: a JWKS that leaked `d` would hand out the signing key.
    for (const key of ring.jwks().keys) expect(key).not.toHaveProperty("d");
  });

  it("refuses a ring with no active key, and a key that is not EC P-256", async () => {
    await expect(SigningKeyRing.fromConfig([{ kid: "k", pem: pem(), state: "RETIRING" }])).rejects.toThrow(/ACTIVE/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(SigningKeyRing.fromConfig([{ kid: "k", pem: rsa, state: "ACTIVE" }])).rejects.toThrow(/P-256/);
  });

  it("serves the configured key on the JWKS route rather than a per-process one", async () => {
    const ring = await SigningKeyRing.fromConfig([{ kid: "configured-key", pem: pem(), state: "ACTIVE" }]);
    const runtime = await buildRuntime({
      signingKeys: ring, store: new MemoryRuntimeStore(), catalogue: new MemoryCatalogueStore(),
    });
    const jwks = await runtime.app.inject({ method: "GET", url: "/api/v1/runtime/jwks" });
    expect(jwks.json().keys.map((key: { kid: string }) => key.kid)).toContain("configured-key");
    await runtime.app.close();
  });
});
