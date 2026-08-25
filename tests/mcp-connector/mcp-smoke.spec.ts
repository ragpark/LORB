/**
 * End-to-end smoke test for the MCP agent connector proof of concept.
 *
 * The MCP connector is exercised over a real HTTP listener with the official MCP client and the
 * streamable HTTP transport, so protocol conformance is genuinely tested. Its outbound calls to the
 * Runtime, Evidence, and roster services are routed through an injected fetch that dispatches into
 * those services' Fastify instances — the connector's own HTTP client code still runs, and the LORB
 * services are the real ones sharing the real in-memory MVP store (see packages/runtime-api/core.ts,
 * which the Evidence API imports directly; they cannot be split across processes in this MVP).
 *
 * `docker compose up -d` starts the same services as containers for manual PoC use; this suite runs
 * them in-process so it is deterministic and part of `pnpm test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { decodeJwt, generateKeyPair } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { buildEvidence, registerEvidenceRoutes } from "../../packages/evidence-api/src/app.js";
import { adminDbPool } from "../../packages/runtime-api/src/db/pool.js";
import { POC_PRINCIPAL } from "../../packages/mcp-connector/src/auth.js";
import { buildMcpConnector } from "../../packages/mcp-connector/src/app.js";
import { loadConfig } from "../../packages/mcp-connector/src/config.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";
import { quizStatementChain, type ShellContext } from "../../packages/quiz-player/src/statements.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { forwardPending } from "../../packages/evidence-forwarder/src/worker.js";
import { receiveStatement } from "../../packages/stub-lrs/src/receiver.js";

const AGENT_TOKEN = "poc-agent-bearer-token-0123456789abcdef";
const SERVICE_TOKEN = "runtime-internal-service-token-0123456789ab";
const RUNTIME_BASE = "http://runtime.smoke.test";
const ROSTER_BASE = "http://roster.smoke.test";
/** The connector now resolves classes from the Runtime API's roster projection rather than the
 *  synthetic stub, so the smoke test seeds a real class the way the Consumer UI would create one. */
const SMOKE_CLASS = {
  class_id: randomUUID(),
  name: "9B Smoke Science",
  year_group: "Year 9",
  subject: "Science",
  topic: { topic: "Photosynthesis", taught_on: "2026-08-10", summary: "Inputs, outputs and where it happens." },
  learners: Array.from({ length: 8 }, (_, index) => `synthetic-smoke-${String(index + 1).padStart(2, "0")}`),
};

const QUIZ_DRAFT = {
  title: "Ratio and proportion check",
  description: "Three questions on the ratio work covered this fortnight.",
  subject: "Mathematics",
  year_group: "Year 9",
  questions: [
    { stem: "Simplify the ratio 12:18.", options: [{ id: "a", text: "Two to three" }, { id: "b", text: "Three to two" }, { id: "c", text: "Six to nine" }], correct_option_id: "a", explanation: "Divide both parts by the highest common factor, 6." },
    { stem: "Share GBP 60 in the ratio 2:3. What is the larger share?", options: [{ id: "a", text: "Twenty-four pounds" }, { id: "b", text: "Thirty-six pounds" }, { id: "c", text: "Thirty pounds" }], correct_option_id: "b", explanation: "Five parts of 12; the larger share is three parts." },
    { stem: "If 4 pens cost GBP 5, what do 12 pens cost?", options: [{ id: "a", text: "Ten pounds" }, { id: "b", text: "Twelve pounds" }, { id: "c", text: "Fifteen pounds" }], correct_option_id: "c", explanation: "Three times as many pens costs three times as much." },
  ],
};

let runtime: Awaited<ReturnType<typeof buildRuntime>>;
let evidence: FastifyInstance;
let connector: FastifyInstance;
let connectorUrl: string;
let iesPrivateKey: CryptoKey | Uint8Array;
let store: MemoryRuntimeStore;
let catalogue: MemoryCatalogueStore;

/** Routes the connector's outbound HTTP through the in-process LORB services. */
const injectingFetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const response = await runtime.app.inject({ method: (init.method ?? "GET") as any, url: input.slice(RUNTIME_BASE.length), headers: init.headers, payload: init.body });
  return { status: response.statusCode, text: async () => response.body };
};

async function connect(): Promise<Client> {
  const client = new Client({ name: "lorb-smoke-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectorUrl), { requestInit: { headers: { authorization: `Bearer ${AGENT_TOKEN}` } } }));
  return client;
}

const toolJson = (result: any) => JSON.parse(result.content[0].text as string);
const resourceJson = (result: { contents: Array<Record<string, unknown>> }) => JSON.parse(String(result.contents[0]!.text));

beforeAll(async () => {
  store = new MemoryRuntimeStore();
  catalogue = new MemoryCatalogueStore();
  const ies = await generateKeyPair("ES256");
  iesPrivateKey = ies.privateKey as unknown as CryptoKey;
  runtime = await buildRuntime({ iesKey: ies.publicKey, secret: Buffer.alloc(32, 9), internalServiceToken: SERVICE_TOKEN, publicIssuer: RUNTIME_BASE, playerOrigin: "http://player.smoke.test", store, catalogue });
  // The Evidence API shares the Runtime's store and verifies descriptors with the Runtime's own key
  // ring, so it is mounted on the Runtime instance here exactly as src/server.ts does.
  evidence = await buildEvidence(runtime.ring, RUNTIME_BASE, store);
  registerEvidenceRoutes(runtime.app as any, runtime.ring, { issuer: RUNTIME_BASE, store });
  await adminDbPool().query("delete from class where class_id = $1", [SMOKE_CLASS.class_id]);
  await adminDbPool().query(
    "insert into class (class_id, name, year_group, subject, created_by_pseudonym) values ($1,$2,$3,$4,'smoke-suite')",
    [SMOKE_CLASS.class_id, SMOKE_CLASS.name, SMOKE_CLASS.year_group, SMOKE_CLASS.subject],
  );
  for (const learner_ref of SMOKE_CLASS.learners) {
    await adminDbPool().query(
      "insert into class_learner (class_id, learner_ref, display_name, added_by_pseudonym) values ($1,$2,$3,'smoke-suite')",
      [SMOKE_CLASS.class_id, learner_ref, `Display ${learner_ref}`],
    );
  }
  await adminDbPool().query(
    "insert into class_topic (class_topic_id, class_id, topic, taught_on, summary) values ($1,$2,$3,$4,$5)",
    [randomUUID(), SMOKE_CLASS.class_id, SMOKE_CLASS.topic.topic, SMOKE_CLASS.topic.taught_on, SMOKE_CLASS.topic.summary],
  );
  // The agent principal must be linked to the class owner before the connector can see anything.
  // A teacher does this once in the Consumer UI; here it stands in for that step. Without it every
  // roster read below 404s, which is the point of the scoping.
  await adminDbPool().query(
    `insert into agent_principal_link (agent_issuer, agent_subject, teacher_pseudonym, label)
     values ($1,$2,'smoke-suite','smoke suite')
     on conflict (agent_issuer, agent_subject) do update set teacher_pseudonym = excluded.teacher_pseudonym, revoked_at = null`,
    [POC_PRINCIPAL.issuer, POC_PRINCIPAL.subject],
  );
  const config = loadConfig({ AUTH_MODE: "poc", MCP_POC_BEARER_TOKEN: AGENT_TOKEN, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN, RUNTIME_API_BASE: RUNTIME_BASE, ROSTER_API_BASE: ROSTER_BASE } as NodeJS.ProcessEnv);
  connector = buildMcpConnector({ config, fetchImpl: injectingFetch });
  await connector.listen({ host: "127.0.0.1", port: 0 });
  const address = connector.server.address();
  connectorUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
});

afterAll(async () => {
  await connector?.close();
  await adminDbPool().query("delete from class where class_id = $1", [SMOKE_CLASS.class_id]).catch(() => undefined);
  await adminDbPool().query("delete from agent_principal_link where agent_issuer = $1 and agent_subject = $2", [POC_PRINCIPAL.issuer, POC_PRINCIPAL.subject]).catch(() => undefined);
  await evidence?.close();
  await runtime?.app.close();
});

describe("MCP agent connector proof of concept", () => {
  let objectId: string;

  it("1. completes MCP initialize and tools/list against the PoC bearer token", async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe("lorb-mcp-connector");
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["assign_quiz", "create_quiz", "list_classes", "whoami"]);

    const assign = tools.tools.find((tool) => tool.name === "assign_quiz")!;
    const create = tools.tools.find((tool) => tool.name === "create_quiz")!;
    // Both mutate; neither is destructive. assign_quiz is the consent-critical one, and says so.
    expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(assign.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(assign.description).toMatch(/confirm with the teacher/i);
    expect(assign.description).toMatch(/affects real learners/i);
    // Smart links are explicitly not the mechanism used for a graded assignment.
    expect(assign.description).not.toMatch(/smart.?link/i);
    await client.close();
  });

  it("1a. serves an unauthenticated endpoint index and health check", async () => {
    // Opening the service in a browser should say what it is, not return a bare 404. Both routes are
    // deliberately outside the auth hook, which covers /mcp only.
    const index = await fetch(connectorUrl.replace(/\/mcp$/, "/"));
    expect(index.status).toBe(200);
    const body = await index.json();
    expect(body).toMatchObject({ name: "LORB MCP connector", status: "ok", auth_mode: "shared-token" });
    expect(body.endpoints).toEqual({ health: "/health", mcp: "/mcp" });

    // The index must never disclose the connector's upstream addresses or either credential.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(AGENT_TOKEN);
    expect(serialised).not.toContain(SERVICE_TOKEN);
    expect(serialised).not.toContain(RUNTIME_BASE);
    expect(serialised).not.toContain(ROSTER_BASE);

    const health = await fetch(connectorUrl.replace(/\/mcp$/, "/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "lorb-mcp-connector" });
  });

  it("1b. rejects a bad bearer token with 401 and an MCP-shaped challenge", async () => {
    const response = await fetch(connectorUrl, {
      method: "POST",
      headers: { authorization: "Bearer not-the-right-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer realm="lorb-mcp-connector"/);

    const missing = await fetch(connectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(missing.status).toBe(401);
  });

  it("1b. list_classes discovers the class without being told its identifier", async () => {
    const client = await connect();
    const listed = toolJson(await client.callTool({ name: "list_classes", arguments: {} }));
    const found = listed.classes.find((entry: { class_id: string }) => entry.class_id === SMOKE_CLASS.class_id);
    expect(found).toBeDefined();
    expect(found.name).toBe(SMOKE_CLASS.name);
    expect(found.learner_count).toBe(SMOKE_CLASS.learners.length);
    // Discovery must not become a roster dump: no learner identifiers, no display names.
    const serialised = JSON.stringify(listed);
    for (const learner of SMOKE_CLASS.learners) expect(serialised).not.toContain(learner);
    expect(serialised).not.toContain("Display synthetic-smoke-01");
    await client.close();
  });

  // Discovery is scoped like every other roster read. A class owned by a different teacher must not
  // appear, or list_classes would hand out exactly the UUIDs the scoping exists to withhold.
  // The dead end this closes: an unlinked assistant sees an empty list and cannot tell anyone which
  // principal to link, because the host keeps its token away from the model.
  it("1a2. whoami reports the principal and its link status", async () => {
    const client = await connect();
    const me = toolJson(await client.callTool({ name: "whoami", arguments: {} }));
    expect(me.authenticated).toBe(true);
    expect(me.issuer).toBe(POC_PRINCIPAL.issuer);
    expect(me.subject).toBe(POC_PRINCIPAL.subject);
    expect(me.linked_to_a_teacher).toBe(true);
    // It reports the caller's own identity, never the teacher it resolves to.
    expect(JSON.stringify(me)).not.toContain("smoke-suite");
    await client.close();
  });

  it("1a3. whoami says so when the principal is not linked to anyone", async () => {
    await adminDbPool().query("update agent_principal_link set revoked_at = now() where agent_issuer = $1 and agent_subject = $2", [POC_PRINCIPAL.issuer, POC_PRINCIPAL.subject]);
    try {
      const client = await connect();
      const me = toolJson(await client.callTool({ name: "whoami", arguments: {} }));
      expect(me.linked_to_a_teacher).toBe(false);
      expect(me.next_step).toContain("AI assistants");
      // And the class list is empty for the same reason, which is the pairing that makes it diagnosable.
      expect(toolJson(await client.callTool({ name: "list_classes", arguments: {} })).classes).toEqual([]);
      await client.close();
    } finally {
      await adminDbPool().query("update agent_principal_link set revoked_at = null where agent_issuer = $1 and agent_subject = $2", [POC_PRINCIPAL.issuer, POC_PRINCIPAL.subject]);
    }
  });

  it("1c. list_classes shows only the linked teacher's classes", async () => {
    const strangerClass = randomUUID();
    await adminDbPool().query(
      "insert into class (class_id, name, year_group, subject, created_by_pseudonym) values ($1,'Someone Else 10Z','Year 10','History','a-different-teacher')",
      [strangerClass],
    );
    try {
      const client = await connect();
      const listed = toolJson(await client.callTool({ name: "list_classes", arguments: {} }));
      const ids = listed.classes.map((entry: { class_id: string }) => entry.class_id);
      expect(ids).toContain(SMOKE_CLASS.class_id);
      expect(ids).not.toContain(strangerClass);
      expect(JSON.stringify(listed)).not.toContain("Someone Else 10Z");
      await client.close();
    } finally {
      await adminDbPool().query("delete from class where class_id = $1", [strangerClass]);
    }
  });

  it("2. reads class://{classId}/recent-topics from the roster the Consumer UI writes", async () => {
    const client = await connect();
    const resource = await client.readResource({ uri: `class://${SMOKE_CLASS.class_id}/recent-topics` });
    const body = resourceJson(resource);
    expect(body.class_id).toBe(SMOKE_CLASS.class_id);
    expect(body.topics.map((entry: { topic: string }) => entry.topic)).toContain(SMOKE_CLASS.topic.topic);
    expect(body.source).toMatch(/non-production/);

    const summary = resourceJson(await client.readResource({ uri: `class://${SMOKE_CLASS.class_id}` }));
    expect(summary.learner_count).toBe(SMOKE_CLASS.learners.length);
    // The class summary must not hand the agent learner identifiers.
    expect(JSON.stringify(summary)).not.toContain(SMOKE_CLASS.learners[0]!);
    await client.close();
  });

  it("3. create_quiz registers an object and returns no answer key", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "create_quiz", arguments: QUIZ_DRAFT });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    objectId = body.object_id;
    expect(body.object_id).toMatch(/^[\da-f-]{36}$/);
    expect(body.package_version).toBe("1.0.0");
    expect(body.question_count).toBe(3);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("correct_option_id");
    // No option text, no stems, no explanations — nothing the key could be reconstructed from.
    for (const question of QUIZ_DRAFT.questions) {
      const answer = question.options.find((option) => option.id === question.correct_option_id)!;
      expect(serialised).not.toContain(answer.text);
      expect(serialised).not.toContain(question.explanation);
      expect(serialised).not.toContain(question.stem);
    }

    // Every quiz reuses the one fixed, already-reviewed player package version.
    const object = (await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects/${objectId}` })).json();
    expect(object.active_package_version_id).toBe("5cbe1b8a-2f2a-4a5c-9f8b-6d1c0a7e4b21");
    expect(object.module_path).toBe("/modules/quiz-player/index.html");
    await client.close();
  });

  it("4. assign_quiz creates learner assignments and treats a repeat idempotency_key as a duplicate", async () => {
    const client = await connect();
    const idempotency_key = `smoke-${randomUUID()}`;
    const first = toolJson(await client.callTool({ name: "assign_quiz", arguments: { object_id: objectId, class_id: SMOKE_CLASS.class_id, idempotency_key } }));
    expect(first.duplicate).toBe(false);
    expect(first.assigned_count).toBe(SMOKE_CLASS.learners.length);
    expect(first.pseudonyms).toHaveLength(SMOKE_CLASS.learners.length);
    for (const pseudonym of first.pseudonyms) expect(pseudonym).toMatch(/^[\da-f]{64}$/);
    // The result must not hand the agent a name-to-pseudonym mapping for the class.
    expect(JSON.stringify(first)).not.toContain("Display synthetic-smoke-01");
    // The agent never receives a learner-scoped launch credential.
    const serialised = JSON.stringify(first);
    expect(serialised).not.toMatch(/signed_descriptor|player_url|eyJ/);
    expect(serialised).not.toContain(SMOKE_CLASS.learners[0]!);

    const assignment = (await store.assignmentsForObject(objectId))[0]!;
    expect(assignment.pseudonyms).toHaveLength(SMOKE_CLASS.learners.length);
    // The Runtime store holds pseudonyms only; the platform learner ids used to derive them are not kept.
    expect(JSON.stringify(assignment)).not.toContain(SMOKE_CLASS.learners[0]!);

    const assignmentsBefore = (await store.assignmentsForObject(objectId)).length;
    const second = toolJson(await client.callTool({ name: "assign_quiz", arguments: { object_id: objectId, class_id: SMOKE_CLASS.class_id, idempotency_key } }));
    expect(second.duplicate).toBe(true);
    expect(second.assignment_id).toBe(first.assignment_id);
    expect((await store.assignmentsForObject(objectId)).length).toBe(assignmentsBefore);
    await client.close();
  });

  it("5. a quiz-player completion emits the launched/answered/completed chain through the real evidence pipeline", async () => {
    // Two of the eight assigned learners sit the quiz, through a normal IES-authenticated launch.
    const sitters = SMOKE_CLASS.learners.slice(0, 2);
    const answerSets = [["a", "b", "c"], ["a", "b", "a"]];

    for (const [index, learner] of sitters.entries()) {
      const token = await issueIesToken(iesPrivateKey as any, learner);
      const launch = await runtime.app.inject({
        method: "POST", url: "/api/v1/runtime/launches",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
        payload: { contract_version: "1.0", consumer_id: "smoke-consumer", repository_id: "b6f1c9d2-6e3a-4f1b-9a7d-1e2f3a4b5c6d", object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB" },
      });
      expect(launch.statusCode).toBe(201);
      const descriptor = launch.json().signed_descriptor as string;
      const claims = decodeJwt(descriptor) as any;

      // The launch the learner actually gets routes to the shared quiz player.
      expect(claims.package_url).toBe("http://player.smoke.test/modules/quiz-player/index.html");

      // The content payload the player fetches — the only place the marking key is served.
      const content = (await runtime.app.inject({ method: "GET", url: `/api/v1/runtime/learning-objects/${objectId}/content` })).json();
      expect(content.questions[0].correct_option_id).toBe("a");

      // Exactly the module's own marking and statement construction (packages/quiz-player).
      const context: ShellContext = {
        repository_id: claims.repository_id, object_id: claims.object_id, object_version_id: claims.object_version_id,
        package_version_id: claims.package_version_id, attempt_id: claims.attempt_id, correlation_id: claims.correlation_id,
        pseudonym: claims.sub, content_url: `${RUNTIME_BASE}/api/v1/runtime/learning-objects/${objectId}/content`,
      };
      const chain = quizStatementChain(context, () => randomUUID(), content, answerSets[index]!);
      expect(chain.map((statement) => statement.verb.display["en-GB"])).toEqual(["launched", "answered", "answered", "answered", "completed"]);

      for (const statement of chain) {
        const posted = await evidence.inject({
          method: "POST", url: "/api/v1/evidence/statements",
          headers: { authorization: `Bearer ${descriptor}`, "idempotency-key": statement.id },
          payload: statement,
        });
        expect(posted.statusCode).toBe(202);
      }

      // Statement UUID deduplication (evidence layer) still holds on a replay.
      const outboxBefore = (await store.listOutbox({})).length;
      await evidence.inject({ method: "POST", url: "/api/v1/evidence/statements", headers: { authorization: `Bearer ${descriptor}`, "idempotency-key": chain[0]!.id }, payload: chain[0] });
      expect((await store.listOutbox({})).length).toBe(outboxBefore);

      await store.transitionAttempt(claims.attempt_id, "STARTED");
      expect((await runtime.app.inject({ method: "POST", url: `/api/v1/runtime/attempts/${claims.attempt_id}/complete`, headers: { authorization: `Bearer ${descriptor}`, "idempotency-key": randomUUID() } })).statusCode).toBe(200);
    }

    await forwardPending((payload, row) => receiveStatement(payload, row.statement_id), {
      store,
      forwarder: { enabled: true, pollIntervalMs: 1000, batchSize: 50, maxAttempts: 5, baseBackoffMs: 100, maxBackoffMs: 1000 },
    });
    const forwarded = (await store.listOutbox({ status: "FORWARDED" }));
    expect(forwarded.length).toBe(10);
  });

  it("6. quiz://{objectId}/results reflects the simulated completions", async () => {
    const client = await connect();
    const body = resourceJson(await client.readResource({ uri: `quiz://${objectId}/results` }));
    expect(body.object_id).toBe(objectId);
    expect(body.assigned_count).toBe(SMOKE_CLASS.learners.length);
    expect(body.completed_count).toBe(2);
    // One learner scored 3/3, the other 2/3 — the mean of the real emitted result.score.scaled values.
    expect(body.average_score_scaled).toBeCloseTo(5 / 6, 3);
    expect(body.not_started_pseudonyms).toHaveLength(SMOKE_CLASS.learners.length - 2);
    for (const pseudonym of body.not_started_pseudonyms) expect(pseudonym).toMatch(/^[\da-f]{64}$/);
    // Results are pseudonym-keyed; no platform learner identifier appears.
    for (const learner of SMOKE_CLASS.learners) expect(JSON.stringify(body)).not.toContain(learner);
    await client.close();
  });
});
