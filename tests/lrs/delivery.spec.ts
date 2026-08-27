/**
 * The forwarder and the store, over a real socket.
 *
 * Every other suite exercises one side of this boundary with the other side stubbed. This one runs
 * the actual `httpSender` — the code that talks to whatever `LRS_ENDPOINT` names — against the actual
 * learning record store, over HTTP, with the credential a deployment would configure. It is the test
 * that would have caught the shape of this integration being wrong: the statements resource path, the
 * `statementId` parameter that makes delivery idempotent, the version header, and the fact that the
 * forwarder counts 409 as delivered.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLrs, testConfig } from "../../packages/lrs/src/app.js";
import { MemoryLrsStore, type LrsStore } from "../../packages/lrs/src/store.js";
import { httpSender, forwardPending } from "../../packages/evidence-forwarder/src/worker.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import type { OutboxRow } from "../../packages/runtime-api/src/store/types.js";

const TOKEN = "the-forwarder-credential-long-enough";
let endpoint = "";
let app: Awaited<ReturnType<typeof buildLrs>>["app"];
let store: LrsStore;

beforeAll(async () => {
  const built = await buildLrs({
    config: testConfig({ credentials: [{ kind: "bearer", token: TOKEN }] }),
    store: new MemoryLrsStore(),
  });
  app = built.app;
  store = built.store;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  endpoint = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(async () => {
  await app?.close();
});

const lrsConfig = (overrides: Record<string, unknown> = {}) => ({
  endpoint,
  auth: { kind: "bearer" as const, token: TOKEN },
  xapiVersion: "1.0.3",
  timeoutMs: 5000,
  ...overrides,
});

const statementFor = (id: string) => ({
  id,
  actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: "d".repeat(64) } },
  verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
  object: { id: "https://lorb.example/activities/ratios", objectType: "Activity" },
  context: { extensions: { "https://lorb.example/xapi/attempt_id": randomUUID() } },
  timestamp: new Date().toISOString(),
});

const rowFor = (statementId: string): OutboxRow => ({
  outbox_id: randomUUID(),
  statement_id: statementId,
  repository_id: randomUUID(),
  attempt_id: randomUUID(),
  package_version_id: randomUUID(),
  object_id: randomUUID(),
  actor_pseudonym: "d".repeat(64),
  verb_id: "http://adlnet.gov/expapi/verbs/completed",
  payload: statementFor(statementId),
  status: "PENDING",
  attempts: 0,
  last_error: null,
  created_at: new Date().toISOString(),
  forwarded_at: null,
  next_attempt_at: new Date().toISOString(),
  dead_lettered_at: null,
  correlation_id: randomUUID(),
});

describe("evidence delivery into the learning record store", () => {
  it("delivers a statement the forwarder claims, and finds it stored", async () => {
    const statementId = randomUUID();
    const send = httpSender(lrsConfig() as never);
    const result = await send(statementFor(statementId), rowFor(statementId));
    expect(result.statusCode).toBe(204);
    expect(await store.get(statementId)).toBeDefined();
  });

  it("is idempotent across a redelivery, which is what the statementId parameter is for", async () => {
    const statementId = randomUUID();
    const send = httpSender(lrsConfig() as never);
    const payload = statementFor(statementId);
    const before = await store.count();
    expect((await send(payload, rowFor(statementId))).statusCode).toBe(204);
    expect((await send(payload, rowFor(statementId))).statusCode).toBe(204);
    expect(await store.count()).toBe(before + 1);
  });

  it("marks the outbox row forwarded when the store accepts it", async () => {
    const runtime = new MemoryRuntimeStore();
    const statementId = randomUUID();
    await runtime.enqueueStatement({
      outbox_id: randomUUID(),
      statement_id: statementId,
      repository_id: randomUUID(),
      attempt_id: randomUUID(),
      package_version_id: randomUUID(),
      object_id: randomUUID(),
      actor_pseudonym: "d".repeat(64),
      verb_id: "http://adlnet.gov/expapi/verbs/completed",
      payload: statementFor(statementId),
      created_at: new Date().toISOString(),
      correlation_id: randomUUID(),
    });

    const summary = await forwardPending(httpSender(lrsConfig() as never), {
      store: runtime,
      forwarder: { batchSize: 10, maxAttempts: 5, baseBackoffMs: 100, maxBackoffMs: 1000, pollIntervalMs: 1000 } as never,
    });
    expect(summary.forwarded).toBe(1);
    expect((await runtime.listOutbox({ status: "FORWARDED" })).map((row) => row.statement_id)).toContain(statementId);
    expect(await store.get(statementId)).toBeDefined();
  });

  it("does not treat a rejected credential as a delivery", async () => {
    const statementId = randomUUID();
    const send = httpSender(lrsConfig({ auth: { kind: "bearer", token: "wrong-credential-entirely" } }) as never);
    const result = await send(statementFor(statementId), rowFor(statementId));
    expect(result.statusCode).toBe(401);
    expect(await store.get(statementId)).toBeUndefined();
  });

  it("reports a conflicting statement as 409, which the forwarder counts as landed", async () => {
    const statementId = randomUUID();
    const send = httpSender(lrsConfig() as never);
    expect((await send(statementFor(statementId), rowFor(statementId))).statusCode).toBe(204);
    const conflicting = { ...statementFor(statementId), result: { completion: false } };
    const result = await send(conflicting, rowFor(statementId));
    expect(result.statusCode).toBe(409);
    // The store keeps what it had; the forwarder stops retrying. Both are correct, and together they
    // are why a duplicate delivery never becomes a dead letter or a second record.
    expect((await store.get(statementId))?.payload).toMatchObject({ id: statementId });
  });
});
