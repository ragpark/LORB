/**
 * Evidence delivery.
 *
 * The behaviour under test is what the previous forwarder did not have: a transient failure is
 * retried rather than discarded, a permanent rejection is not retried for ever, and an exhausted
 * statement becomes a visible, replayable dead letter instead of disappearing.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backoffMs, forwardPending, httpSender, type DeliveryResult } from "../../packages/evidence-forwarder/src/worker.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";

const forwarder = {
  enabled: true, pollIntervalMs: 1000, batchSize: 25, maxAttempts: 3,
  baseBackoffMs: 1000, maxBackoffMs: 60000,
};

async function storeWithStatement(): Promise<{ store: MemoryRuntimeStore; statementId: string; outboxId: string }> {
  const store = new MemoryRuntimeStore();
  const statementId = randomUUID();
  const outboxId = randomUUID();
  await store.enqueueStatement({
    outbox_id: outboxId, statement_id: statementId, repository_id: randomUUID(),
    attempt_id: randomUUID(), package_version_id: randomUUID(), object_id: randomUUID(),
    actor_pseudonym: "a".repeat(64), verb_id: "http://adlnet.gov/expapi/verbs/completed",
    payload: { id: statementId }, created_at: new Date().toISOString(), correlation_id: randomUUID(),
  });
  return { store, statementId, outboxId };
}

const responds = (result: DeliveryResult) => async () => result;

describe("evidence forwarder", () => {
  it("marks a delivered statement as forwarded", async () => {
    const { store, statementId } = await storeWithStatement();
    const summary = await forwardPending(responds({ statusCode: 204 }), { store, forwarder });
    expect(summary).toMatchObject({ claimed: 1, forwarded: 1, retried: 0, deadLettered: 0 });
    expect((await store.getOutboxByStatement(statementId))?.status).toBe("FORWARDED");
  });

  it("treats a 409 from the learning record store as delivered", async () => {
    // xAPI deduplicates on the statement id, so a receiver that already holds it has the evidence.
    const { store, statementId } = await storeWithStatement();
    await forwardPending(responds({ statusCode: 409 }), { store, forwarder });
    expect((await store.getOutboxByStatement(statementId))?.status).toBe("FORWARDED");
  });

  it("retries a transient failure rather than discarding the statement", async () => {
    const { store, statementId } = await storeWithStatement();
    const summary = await forwardPending(responds({ statusCode: 503, body: "unavailable" }), { store, forwarder });
    expect(summary.retried).toBe(1);
    const row = await store.getOutboxByStatement(statementId);
    expect(row?.status).toBe("FAILED");
    expect(row?.last_error).toContain("503");
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("retries a network failure, which is not a rejection", async () => {
    const { store, statementId } = await storeWithStatement();
    await forwardPending(async () => { throw new Error("ECONNREFUSED"); }, { store, forwarder });
    const row = await store.getOutboxByStatement(statementId);
    expect(row?.status).toBe("FAILED");
    expect(row?.last_error).toContain("ECONNREFUSED");
  });

  it("does not retry a statement the receiver rejected as malformed", async () => {
    // A 400 will not become a 200 on the tenth attempt, and retrying it starves the queue behind it.
    const { store, statementId } = await storeWithStatement();
    const summary = await forwardPending(responds({ statusCode: 400, body: "bad statement" }), { store, forwarder });
    expect(summary.deadLettered).toBe(1);
    expect((await store.getOutboxByStatement(statementId))?.status).toBe("DEAD_LETTER");
  });

  it("retries a 429 and a 408, which are not permanent rejections", async () => {
    for (const statusCode of [429, 408]) {
      const { store, statementId } = await storeWithStatement();
      await forwardPending(responds({ statusCode }), { store, forwarder });
      expect((await store.getOutboxByStatement(statementId))?.status).toBe("FAILED");
    }
  });

  it("dead-letters only after the attempt budget is spent, and never deletes the statement", async () => {
    const { store, statementId } = await storeWithStatement();
    // Each pass runs an hour after the last, so the backoff the previous failure set has elapsed.
    let clock = Date.now();
    const now = () => new Date(clock);
    for (let pass = 0; pass < forwarder.maxAttempts; pass += 1) {
      await forwardPending(responds({ statusCode: 503 }), { store, forwarder, now });
      clock += 3600_000;
    }
    const row = await store.getOutboxByStatement(statementId);
    expect(row?.status).toBe("DEAD_LETTER");
    expect(row?.attempts).toBe(forwarder.maxAttempts);
    expect(row?.payload).toMatchObject({ id: statementId });
  });

  it("requeues a dead letter and delivers it", async () => {
    const { store, statementId, outboxId } = await storeWithStatement();
    await forwardPending(responds({ statusCode: 400 }), { store, forwarder });
    expect(await store.requeueStatement(outboxId, statementId)).toBe(true);
    await forwardPending(responds({ statusCode: 204 }), { store, forwarder });
    expect((await store.getOutboxByStatement(statementId))?.status).toBe("FORWARDED");
  });

  it("refuses a requeue that names a different statement", async () => {
    const { store, outboxId } = await storeWithStatement();
    await forwardPending(responds({ statusCode: 400 }), { store, forwarder });
    expect(await store.requeueStatement(outboxId, randomUUID())).toBe(false);
  });

  it("leaves a statement that is not yet due alone", async () => {
    const { store } = await storeWithStatement();
    await forwardPending(responds({ statusCode: 503 }), { store, forwarder });
    const summary = await forwardPending(responds({ statusCode: 204 }), { store, forwarder });
    expect(summary.claimed).toBe(0);
  });

  it("backs off exponentially, with jitter, up to the configured ceiling", async () => {
    // Full jitter: without it, every replica retries the same batch at the same instant after an
    // outage, which is when the receiver can least absorb it.
    expect(backoffMs(1, forwarder, () => 0)).toBe(500);
    expect(backoffMs(1, forwarder, () => 1)).toBe(1000);
    expect(backoffMs(3, forwarder, () => 1)).toBe(4000);
    expect(backoffMs(30, forwarder, () => 1)).toBe(forwarder.maxBackoffMs);
  });

  it("sends the statement id as the xAPI statementId parameter, which makes delivery idempotent", async () => {
    const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL, init: { method?: string; headers: Record<string, string> }) => {
      calls.push({ url: url.toString(), method: init.method, headers: init.headers });
      return { ok: true, status: 204, text: async () => "" };
    }) as never;
    try {
      const { store, statementId } = await storeWithStatement();
      await forwardPending(httpSender({
        endpoint: "https://lrs.example/xapi",
        auth: { kind: "basic", username: "key", password: "secret" },
        xapiVersion: "1.0.3",
        timeoutMs: 5000,
      }), { store, forwarder });
      expect(calls[0]!.url).toBe(`https://lrs.example/xapi/statements?statementId=${statementId}`);
      expect(calls[0]!.method).toBe("PUT");
      expect(calls[0]!.headers["x-experience-api-version"]).toBe("1.0.3");
      expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
