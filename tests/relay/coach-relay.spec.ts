/**
 * The experience relay, tested at its trust boundary.
 *
 * The properties that matter: only a valid launch descriptor gets a reply; the provider's URL and
 * credentials come from configuration and never from — or back to — the browser; an endpoint is a
 * name; the built-in demo answers with no outbound call at all; and a provider failing loses the
 * turn with a 502, never the attempt.
 */
import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { buildRuntime } from "../../packages/runtime-api/src/app.js";
import { registerRelayRoutes, endpointsFromEnvironment } from "../../packages/experience-relay/src/app.js";
import { issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { MemoryRuntimeStore } from "../../packages/runtime-api/src/store/index.js";
import { MemoryCatalogueStore } from "../../packages/runtime-api/src/catalogue/index.js";

async function setup(options: { endpoints?: Record<string, { url: string; authorization?: string }>; fetchImpl?: typeof fetch; perMinute?: number } = {}) {
  const ies = await generateKeyPair("ES256");
  const issuer = `https://ies.relay-${randomUUID()}.test`;
  const publicIssuer = "http://localhost:3000";
  const catalogue = new MemoryCatalogueStore();
  const runtime = await buildRuntime({
    iesKey: ies.publicKey, iesIssuer: issuer, playerOrigin: `https://player.relay-${randomUUID()}.test`,
    secret: Buffer.alloc(32, 8), store: new MemoryRuntimeStore(), catalogue, publicIssuer,
  });
  if (options.perMinute !== undefined) {
    // Mirrors production: the plugin registered global: false, so the route's own config must be
    // where the limit lives — this is what proves the nesting @fastify/rate-limit v9 discovers.
    await runtime.app.register(rateLimit, { global: false });
  }
  registerRelayRoutes(runtime.app, runtime.ring, { issuer: publicIssuer, endpoints: options.endpoints ?? {}, fetchImpl: options.fetchImpl, timeoutMs: 2000, perMinute: options.perMinute });

  const learnerToken = await issueIesToken(ies.privateKey, "relay-learner", "lorb-runtime", issuer, {});
  const objectId = (await catalogue.learningObjects({ status: "PUBLISHED" }))[0]!.object_id;
  const repositoryId = (await catalogue.learningObjects({ status: "PUBLISHED" }))[0]!.repository_id;
  const launch = await runtime.app.inject({
    method: "POST", url: "/api/v1/runtime/launches",
    headers: { authorization: `Bearer ${learnerToken}`, "idempotency-key": randomUUID() },
    payload: { contract_version: "1.0", consumer_id: "relay-suite", repository_id: repositoryId, object_id: objectId, requested_launch_mode: "embedded-iframe", locale: "en-GB" },
  });
  expect(launch.statusCode).toBe(201);
  const descriptor = launch.json().signed_descriptor as string;

  // null means "send no Authorization header at all" — an explicit undefined would take the default.
  const relay = (payload: unknown, auth: string | null = `Bearer ${descriptor}`) =>
    runtime.app.inject({
      method: "POST", url: "/api/v1/relay/coach/messages",
      headers: { ...(auth === null ? {} : { authorization: auth }), "content-type": "application/json" },
      payload: payload as never,
    });

  return { runtime, relay, descriptor };
}

const turn = (endpoint = "demo") => ({
  endpoint,
  messages: [{ role: "learner", content: "I think photosynthesis makes oxygen at night." }],
  context: { topic: "photosynthesis" },
});

describe("coach relay", () => {
  it("refuses a request without a valid descriptor", async () => {
    const { runtime, relay } = await setup();
    expect((await relay(turn(), null)).statusCode).toBe(401);
    expect((await relay(turn(), "Bearer not-a-descriptor")).statusCode).toBe(401);
    await runtime.app.close();
  });

  it("answers the demo endpoint locally, labelled and with no outbound call", async () => {
    const fetchSpy = vi.fn();
    const { runtime, relay } = await setup({ fetchImpl: fetchSpy as never });
    const response = await relay(turn());
    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toContain("photosynthesis");
    expect(response.json().reply).toContain("demo coach");
    expect(fetchSpy).not.toHaveBeenCalled();
    await runtime.app.close();
  });

  it("relays a named endpoint with server-side credentials, and returns only the reply", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ reply: "Good — now, what happens to that oxygen in the dark?" }), { status: 200 }));
    const { runtime, relay } = await setup({
      endpoints: { "coach-default": { url: "https://langgraph.internal.example/coach", authorization: "Bearer provider-secret" } },
      fetchImpl: fetchSpy as never,
    });
    const response = await relay(turn("coach-default"));
    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toContain("oxygen in the dark");
    // The provider was called at the configured URL with the configured credential...
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://langgraph.internal.example/coach");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer provider-secret");
    // ...the outbound body carries the pseudonymous attempt facts and the conversation, nothing else...
    const outbound = JSON.parse(String(init.body));
    expect(Object.keys(outbound).sort()).toEqual(["attempt_id", "context", "correlation_id", "messages", "object_id", "pseudonym"]);
    // ...and nothing about the provider leaks back to the browser.
    expect(JSON.stringify(response.json())).not.toContain("provider-secret");
    expect(JSON.stringify(response.json())).not.toContain("langgraph.internal.example");
    await runtime.app.close();
  });

  it("refuses an unknown endpoint name and a malformed request", async () => {
    const { runtime, relay } = await setup();
    expect((await relay(turn("never-configured"))).statusCode).toBe(404);
    expect((await relay({ endpoint: "https://evil.example/exfiltrate", messages: [{ role: "learner", content: "hi" }] })).statusCode).toBe(400);
    expect((await relay({ endpoint: "demo", messages: [] })).statusCode).toBe(400);
    expect((await relay({ endpoint: "demo", messages: [{ role: "learner", content: "hi" }], stylesheet: "x" })).statusCode).toBe(400);
    await runtime.app.close();
  });

  it("turns a provider failure into a 502, never an exception", async () => {
    const failing = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    const { runtime, relay } = await setup({
      endpoints: { "coach-default": { url: "https://langgraph.internal.example/coach" } },
      fetchImpl: failing as never,
    });
    expect((await relay(turn("coach-default"))).statusCode).toBe(502);
    await runtime.app.close();

    const refused = await setup({
      endpoints: { "coach-default": { url: "https://langgraph.internal.example/coach" } },
      fetchImpl: (async () => { throw new Error("connection refused"); }) as never,
    });
    expect((await refused.relay(turn("coach-default"))).statusCode).toBe(502);
    await refused.runtime.app.close();
  });

  it("rate-limits the route where the host app enforces limits, with a 429 past the ceiling", async () => {
    const { runtime, relay } = await setup({ perMinute: 2 });
    expect((await relay(turn())).statusCode).toBe(200);
    expect((await relay(turn())).statusCode).toBe(200);
    expect((await relay(turn())).statusCode).toBe(429);
    await runtime.app.close();
  });

  it("reads only well-formed https endpoints from the environment", () => {
    expect(endpointsFromEnvironment(JSON.stringify({
      "coach-default": { url: "https://provider.example/coach", authorization: "Bearer k" },
      "bad-url": { url: "http://plaintext.example/coach" },
      "local-dev": { url: "http://localhost:8123/coach" },
      "Bad Name": { url: "https://provider.example" },
    }))).toEqual({
      "coach-default": { url: "https://provider.example/coach", authorization: "Bearer k" },
      "local-dev": { url: "http://localhost:8123/coach" },
    });
    expect(endpointsFromEnvironment("not json")).toEqual({});
    expect(endpointsFromEnvironment(undefined)).toEqual({});
  });
});
