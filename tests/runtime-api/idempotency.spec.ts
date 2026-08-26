/**
 * Idempotency as a retry actually arrives.
 *
 * Requiring an `Idempotency-Key` and then storing the response afterwards is not idempotency, and
 * the failure it hides is the expensive one: two replicas handling the same key at the same moment
 * both see no stored response, both do the work — two attempts, two launches, two learning objects —
 * and only then race to store one of the two answers. The unique constraint keeps exactly one, the
 * caller sees one response, and believes one thing happened.
 *
 * So these tests are about the concurrent case as much as the sequential one, and they assert on
 * what was created rather than only on what was returned.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const ISSUER = "https://identity.idempotency.test";

async function setup() {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore();
  const runtime = await buildRuntime({ iesKey: keys.publicKey, iesIssuer: ISSUER, secret: Buffer.alloc(32, 7), store, catalogue });
  const [object] = await catalogue.learningObjects();
  const token = await issueIesToken(keys.privateKey, "learner-idem", "lorb-runtime", ISSUER);
  return { runtime, store, catalogue, object: object!, token };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const launch = (h: Harness, key: string, overrides: Record<string, unknown> = {}) =>
  h.runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${h.token}`, "idempotency-key": key },
    payload: {
      contract_version: "1.0", consumer_id: "idempotency-suite",
      repository_id: h.object.repository_id, object_id: h.object.object_id,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
      ...overrides,
    },
  });

describe("launch idempotency", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("creates one attempt when the same key arrives twice at once", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([launch(h, key), launch(h, key)]);

    const statuses = [first.statusCode, second.statusCode].sort();
    // One caller does the work; the other is told the key is in flight rather than repeating it.
    expect(statuses).toEqual([201, 409]);
    expect([first, second].find((r) => r.statusCode === 409)!.json().code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect(await h.store.listAttempts({})).toHaveLength(1);
  });

  it("replays the original response to a later identical retry", async () => {
    const key = randomUUID();
    const first = await launch(h, key);
    const retry = await launch(h, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    // The descriptor is a bearer credential; a retry must get the one already issued, not a new one.
    expect(retry.json().signed_descriptor).toBe(first.json().signed_descriptor);
    expect(retry.json().attempt_id).toBe(first.json().attempt_id);
    expect(await h.store.listAttempts({})).toHaveLength(1);
  });

  it("refuses the same key used for a different request", async () => {
    const key = randomUUID();
    expect((await launch(h, key)).statusCode).toBe(201);
    const different = await launch(h, key, { locale: "cy-GB" });
    expect(different.statusCode).toBe(409);
    expect(different.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await h.store.listAttempts({})).toHaveLength(1);
  });

  it("frees the key when the request it claimed was refused", async () => {
    const key = randomUUID();
    // An unknown object: nothing was created, so nothing should be pinned to the key. A caller who
    // corrects the request and retries with the same key must not be locked out for a day.
    const refused = await launch(h, key, { object_id: randomUUID() });
    expect(refused.statusCode).toBe(404);

    const corrected = await launch(h, key);
    expect(corrected.statusCode).toBe(201);
    expect(await h.store.listAttempts({})).toHaveLength(1);
  });

  it("does not let one key replay another surface's response", async () => {
    const key = randomUUID();
    expect((await launch(h, key)).statusCode).toBe(201);
    // Scoped per surface: the internal quiz surface has its own record space.
    const claim = await h.store.claimIdempotent("internal-quiz", key, "", 60_000);
    expect(claim.state).toBe("reserved");
  });
});

describe("the idempotency claim itself", () => {
  it("reports in flight until the claim completes, then replays", async () => {
    const store = new MemoryRuntimeStore();
    expect((await store.claimIdempotent("scope", "k", "fp", 60_000)).state).toBe("reserved");
    expect((await store.claimIdempotent("scope", "k", "fp", 60_000)).state).toBe("in_flight");

    await store.completeIdempotent("scope", "k", 201, { ok: true });
    expect(await store.claimIdempotent("scope", "k", "fp", 60_000)).toEqual({ state: "replay", status_code: 201, response: { ok: true } });
  });

  it("reports a mismatch before it reports in flight, so a reused key is never answered", async () => {
    const store = new MemoryRuntimeStore();
    await store.claimIdempotent("scope", "k", "fingerprint-a", 60_000);
    expect((await store.claimIdempotent("scope", "k", "fingerprint-b", 60_000)).state).toBe("mismatch");
  });

  it("frees a released claim without freeing a completed one", async () => {
    const store = new MemoryRuntimeStore();
    await store.claimIdempotent("scope", "released", "fp", 60_000);
    await store.releaseIdempotent("scope", "released");
    expect((await store.claimIdempotent("scope", "released", "fp", 60_000)).state).toBe("reserved");

    await store.claimIdempotent("scope", "kept", "fp", 60_000);
    await store.completeIdempotent("scope", "kept", 201, { ok: true });
    await store.releaseIdempotent("scope", "kept");
    expect((await store.claimIdempotent("scope", "kept", "fp", 60_000)).state).toBe("replay");
  });
});
