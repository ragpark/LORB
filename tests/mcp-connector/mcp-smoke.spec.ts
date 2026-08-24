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
import { buildRoster } from "../../packages/stub-roster/src/app.js";
import { STUB_CLASSES } from "../../packages/stub-roster/src/seed.js";
import { buildMcpConnector } from "../../packages/mcp-connector/src/app.js";
import { loadConfig } from "../../packages/mcp-connector/src/config.js";
import { store } from "../../packages/runtime-api/src/core.js";
import { resetCatalogue } from "../../packages/runtime-api/src/services/catalogue.js";
import { quizStatementChain, type ShellContext } from "../../packages/quiz-player/src/statements.js";
import { issueIesToken } from "../../packages/stub-ies/src/issuer.js";
import { forwardPending } from "../../packages/evidence-forwarder/src/worker.js";
import { receiveStatement } from "../../packages/stub-lrs/src/receiver.js";

const AGENT_TOKEN = "poc-agent-bearer-token-0123456789abcdef";
const SERVICE_TOKEN = "runtime-internal-service-token-0123456789ab";
const RUNTIME_BASE = "http://runtime.smoke.test";
const ROSTER_BASE = "http://roster.smoke.test";
const STUB_CLASS = STUB_CLASSES[0]!;

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
let roster: FastifyInstance;
let connector: FastifyInstance;
let connectorUrl: string;
let iesPrivateKey: CryptoKey | Uint8Array;

/** Routes the connector's outbound HTTP through the in-process LORB services. */
const injectingFetch = async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const target = input.startsWith(ROSTER_BASE) ? roster : runtime.app;
  const base = input.startsWith(ROSTER_BASE) ? ROSTER_BASE : RUNTIME_BASE;
  const response = await target.inject({ method: (init.method ?? "GET") as any, url: input.slice(base.length), headers: init.headers, payload: init.body });
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
  store.attempts.clear(); store.launches.clear(); store.idempotency.clear(); store.outbox.clear(); store.assignments.clear();
  resetCatalogue();
  const ies = await generateKeyPair("ES256");
  iesPrivateKey = ies.privateKey as unknown as CryptoKey;
  runtime = await buildRuntime({ iesKey: ies.publicKey, secret: Buffer.alloc(32, 9), internalServiceToken: SERVICE_TOKEN, publicIssuer: RUNTIME_BASE, playerOrigin: "http://player.smoke.test" });
  // The Evidence API shares the Runtime's in-memory store and verifies descriptors with the Runtime's
  // own key, so it is mounted on the Runtime instance here exactly as src/server.ts does in the PoC host.
  evidence = await buildEvidence(runtime.keys.privateKey, RUNTIME_BASE);
  registerEvidenceRoutes(runtime.app as any, runtime.keys.privateKey, RUNTIME_BASE);
  roster = await buildRoster();
  const config = loadConfig({ AUTH_MODE: "poc", MCP_POC_BEARER_TOKEN: AGENT_TOKEN, RUNTIME_INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN, RUNTIME_API_BASE: RUNTIME_BASE, ROSTER_API_BASE: ROSTER_BASE } as NodeJS.ProcessEnv);
  connector = buildMcpConnector({ config, fetchImpl: injectingFetch });
  await connector.listen({ host: "127.0.0.1", port: 0 });
  const address = connector.server.address();
  connectorUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
});

afterAll(async () => {
  await connector?.close();
  await roster?.close();
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
    expect(names).toEqual(["assign_quiz", "create_quiz"]);

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
    expect(body).toMatchObject({ name: "LORB MCP connector", status: "ok", production: false, auth_mode: "poc" });
    expect(body.endpoints).toEqual({ health: "/health", mcp: "/mcp" });
    expect(body.notice).toMatch(/NOT CERTIFIED/);

    // The index must never disclose the connector's upstream addresses or either credential.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(AGENT_TOKEN);
    expect(serialised).not.toContain(SERVICE_TOKEN);
    expect(serialised).not.toContain(RUNTIME_BASE);
    expect(serialised).not.toContain(ROSTER_BASE);

    const health = await fetch(connectorUrl.replace(/\/mcp$/, "/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "lorb-mcp-connector", production: false });
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

  it("2. reads class://{classId}/recent-topics from the roster stub", async () => {
    const client = await connect();
    const resource = await client.readResource({ uri: `class://${STUB_CLASS.class_id}/recent-topics` });
    const body = resourceJson(resource);
    expect(body.class_id).toBe(STUB_CLASS.class_id);
    expect(body.topics.map((entry: { topic: string }) => entry.topic)).toContain(STUB_CLASS.recent_topics[0]!.topic);
    expect(body.source).toMatch(/non-production/);

    const summary = resourceJson(await client.readResource({ uri: `class://${STUB_CLASS.class_id}` }));
    expect(summary.learner_count).toBe(STUB_CLASS.learners.length);
    // The class summary must not hand the agent learner identifiers.
    expect(JSON.stringify(summary)).not.toContain(STUB_CLASS.learners[0]!.learner_id);
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
    const first = toolJson(await client.callTool({ name: "assign_quiz", arguments: { object_id: objectId, class_id: STUB_CLASS.class_id, idempotency_key } }));
    expect(first.duplicate).toBe(false);
    expect(first.assigned_count).toBe(STUB_CLASS.learners.length);
    expect(first.learners).toHaveLength(STUB_CLASS.learners.length);
    for (const learner of first.learners) expect(learner.pseudonym).toMatch(/^[\da-f]{64}$/);
    // The agent never receives a learner-scoped launch credential.
    const serialised = JSON.stringify(first);
    expect(serialised).not.toMatch(/signed_descriptor|player_url|eyJ/);
    expect(serialised).not.toContain(STUB_CLASS.learners[0]!.learner_id);

    const assignment = [...store.assignments.values()].find((entry) => entry.object_id === objectId)!;
    expect(assignment.pseudonyms).toHaveLength(STUB_CLASS.learners.length);
    // The Runtime store holds pseudonyms only; the platform learner ids used to derive them are not kept.
    expect(JSON.stringify(assignment)).not.toContain(STUB_CLASS.learners[0]!.learner_id);

    const assignmentsBefore = store.assignments.size;
    const second = toolJson(await client.callTool({ name: "assign_quiz", arguments: { object_id: objectId, class_id: STUB_CLASS.class_id, idempotency_key } }));
    expect(second.duplicate).toBe(true);
    expect(second.assignment_id).toBe(first.assignment_id);
    expect(store.assignments.size).toBe(assignmentsBefore);
    await client.close();
  });

  it("5. a quiz-player completion emits the launched/answered/completed chain through the real evidence pipeline", async () => {
    // Two of the eight assigned learners sit the quiz, through a normal IES-authenticated launch.
    const sitters = STUB_CLASS.learners.slice(0, 2);
    const answerSets = [["a", "b", "c"], ["a", "b", "a"]];

    for (const [index, learner] of sitters.entries()) {
      const token = await issueIesToken(iesPrivateKey as any, learner.learner_id);
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
      const outboxBefore = store.outbox.size;
      await evidence.inject({ method: "POST", url: "/api/v1/evidence/statements", headers: { authorization: `Bearer ${descriptor}`, "idempotency-key": chain[0]!.id }, payload: chain[0] });
      expect(store.outbox.size).toBe(outboxBefore);

      const attempt = store.attempts.get(claims.attempt_id)!;
      attempt.status = "STARTED";
      expect((await runtime.app.inject({ method: "POST", url: `/api/v1/runtime/attempts/${claims.attempt_id}/complete`, headers: { authorization: `Bearer ${descriptor}`, "idempotency-key": randomUUID() } })).statusCode).toBe(200);
    }

    await forwardPending(receiveStatement);
    const forwarded = [...store.outbox.values()].filter((row: any) => row.status === "FORWARDED");
    expect(forwarded.length).toBe(10);
  });

  it("6. quiz://{objectId}/results reflects the simulated completions", async () => {
    const client = await connect();
    const body = resourceJson(await client.readResource({ uri: `quiz://${objectId}/results` }));
    expect(body.object_id).toBe(objectId);
    expect(body.assigned_count).toBe(STUB_CLASS.learners.length);
    expect(body.completed_count).toBe(2);
    // One learner scored 3/3, the other 2/3 — the mean of the real emitted result.score.scaled values.
    expect(body.average_score_scaled).toBeCloseTo(5 / 6, 3);
    expect(body.not_started_pseudonyms).toHaveLength(STUB_CLASS.learners.length - 2);
    for (const pseudonym of body.not_started_pseudonyms) expect(pseudonym).toMatch(/^[\da-f]{64}$/);
    // Results are pseudonym-keyed; no platform learner identifier appears.
    for (const learner of STUB_CLASS.learners) expect(JSON.stringify(body)).not.toContain(learner.learner_id);
    await client.close();
  });
});
