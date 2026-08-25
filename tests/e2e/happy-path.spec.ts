/**
 * The end-to-end slice: launch, state, evidence acceptance, completion and delivery to the learning
 * record store — through the same store and forwarder a deployment runs.
 */
import { expect, it } from "vitest";
import { decodeJwt, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { buildEvidence } from "../../packages/evidence-api/src/app.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { forwardPending } from "../../packages/evidence-forwarder/src/worker.js";
import { receiveStatement, resetStatements, storedStatements } from "../../packages/stub-lrs/src/receiver.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

const forwarderConfig = {
  enabled: true, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5,
  baseBackoffMs: 100, maxBackoffMs: 1000,
};

it("executes the launch, state, evidence, forwarding and completion slice", async () => {
  resetStatements();
  const store = new MemoryRuntimeStore();
  const catalogue = new MemoryCatalogueStore();
  const ies = await generateKeyPair("ES256");
  const runtime = await buildRuntime({ iesKey: ies.publicKey, secret: Buffer.alloc(32, 3), store, catalogue });
  const token = await issueIesToken(ies.privateKey, "test-subject");
  const [object] = await catalogue.learningObjects();

  const launch = await runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: {
      contract_version: "1.0", consumer_id: "test-activehub",
      repository_id: object!.repository_id, object_id: object!.object_id,
      requested_launch_mode: "embedded-iframe", locale: "en-GB",
    },
  });
  expect(launch.statusCode).toBe(201);
  const response = launch.json();
  const descriptor = decodeJwt(response.signed_descriptor);

  // The descriptor binds to the object version the catalogue actually published, not a per-launch
  // identifier: two attempts at the same content agree on what was delivered.
  expect(descriptor.object_version_id).toBe(object!.active_object_version_id);
  expect(descriptor.package_version_id).toBe(object!.active_package_version_id);

  const state = await runtime.app.inject({
    method: "PUT", url: `/api/v1/runtime/attempts/${response.attempt_id}/state`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
    payload: { revision: 1, state_payload: { page: 2 } },
  });
  expect(state.statusCode).toBe(200);
  expect(state.json().status).toBe("STARTED");

  const evidence = await buildEvidence(runtime.ring, undefined, store);
  const statement = {
    id: randomUUID(),
    actor: { objectType: "Agent", account: { homePage: "https://lorb.example/pseudonym", name: descriptor.sub } },
    verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-GB": "completed" } },
    object: { id: `https://lorb.example/objects/${descriptor.object_id}/versions/${descriptor.object_version_id}`, objectType: "Activity" },
    context: {
      extensions: {
        "https://lorb.example/xapi/repository_id": descriptor.repository_id,
        "https://lorb.example/xapi/attempt_id": descriptor.attempt_id,
        "https://lorb.example/xapi/package_version_id": descriptor.package_version_id,
        "https://lorb.example/xapi/correlation_id": descriptor.correlation_id,
        "https://lorb.example/xapi/completion_authority": "PACKAGE",
      },
    },
    timestamp: new Date().toISOString(),
  };
  const accepted = await evidence.inject({
    method: "POST", url: "/api/v1/evidence/statements",
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": statement.id },
    payload: statement,
  });
  expect(accepted.statusCode).toBe(202);

  const complete = await runtime.app.inject({
    method: "POST", url: `/api/v1/runtime/attempts/${response.attempt_id}/complete`,
    headers: { authorization: `Bearer ${response.signed_descriptor}`, "idempotency-key": randomUUID() },
  });
  expect(complete.statusCode).toBe(200);

  const summary = await forwardPending((payload, row) => receiveStatement(payload, row.statement_id), { store, forwarder: forwarderConfig });
  expect(summary.forwarded).toBe(1);
  expect((await store.getAttempt(response.attempt_id))?.status).toBe("COMPLETED");
  expect((await store.getOutboxByStatement(statement.id))?.status).toBe("FORWARDED");
  expect(storedStatements().map((row) => row.statement_id)).toContain(statement.id);
});
