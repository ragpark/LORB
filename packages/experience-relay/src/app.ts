/**
 * The experience relay: how a sandboxed player reaches an AI provider without ever holding a key.
 *
 * A coaching player runs in the learner's browser, inside a sandboxed iframe, from an opaque
 * origin. It cannot be trusted with an API key and it cannot call a provider directly, so it does
 * neither: it authenticates here with the launch descriptor it already holds — the same credential,
 * used the same way, as when it saves state or emits evidence — and names an *endpoint*. The relay
 * resolves that name to a real URL and credentials from operator configuration, makes the call
 * server-side, and returns only the reply.
 *
 * The endpoint name is the whole point of the design: a learning object's launch context says
 * `llm_endpoint: "coach-default"`, and what that means — which provider, which URL, which key — is
 * service configuration an operator changes without republishing anything. This is the first brick
 * of the provider-adaptor layer, deliberately small: one provider shape, one route.
 *
 * A built-in `demo` endpoint answers locally with a canned coaching turn, so the whole experience —
 * launch, chat, evidence, completion — can be exercised before any provider exists. It is labelled
 * in its own replies and calls nothing.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { coachRelayRequestSchema, type CoachRelayRequest } from "../../contracts/src/index.js";
import { verifyDescriptor, type SigningKeyRing } from "../../runtime-api/src/core.js";
import { sendProblem } from "../../runtime-api/src/services/problem.js";

export interface RelayEndpoint {
  /** Where the provider listens. https only — this URL travels with credentials. */
  url: string;
  /** Sent verbatim as the outbound Authorization header. Never appears in any response or log. */
  authorization?: string;
}

export interface RelayOptions {
  issuer?: string;
  /** Named endpoints. Defaults to RELAY_COACH_ENDPOINTS (a JSON object of name → endpoint). */
  endpoints?: Record<string, RelayEndpoint>;
  /** Test seam for the outbound call. */
  fetchImpl?: typeof fetch;
  /** Outbound timeout. Providers that think for longer than this lose the turn, not the attempt. */
  timeoutMs?: number;
  /**
   * Per-address route limit, honoured where the host app has @fastify/rate-limit registered. A
   * relay turn can occupy a paid provider for many seconds, so it must not be the one launch-path
   * route the runtime's production abuse controls skip.
   */
  perMinute?: number;
}

/**
 * Reads the operator's endpoint map. Refuses quietly rather than loudly: a malformed value is
 * logged by the caller's boot line, and the relay runs with only the demo endpoint — a broken
 * provider map must not take down launches that never use the relay.
 */
export function endpointsFromEnvironment(raw = process.env.RELAY_COACH_ENDPOINTS): Record<string, RelayEndpoint> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, RelayEndpoint>;
    const valid: Record<string, RelayEndpoint> = {};
    for (const [name, endpoint] of Object.entries(parsed)) {
      if (!/^[a-z][a-z\d-]{0,63}$/.test(name)) continue;
      if (typeof endpoint?.url !== "string") continue;
      const url = new URL(endpoint.url);
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") continue;
      valid[name] = { url: endpoint.url, ...(typeof endpoint.authorization === "string" ? { authorization: endpoint.authorization } : {}) };
    }
    return valid;
  } catch {
    return {};
  }
}

/**
 * The built-in provider: a canned coaching turn, generated locally, labelled as the demo. It
 * exists so the full journey can be demonstrated — and tested — before a real provider is
 * configured, and it deliberately sounds like scaffolding rather than pretending to be a tutor.
 */
function demoReply(request: CoachRelayRequest): string {
  const lastLearnerTurn = [...request.messages].reverse().find((message) => message.role === "learner");
  const topic = typeof request.context?.topic === "string" ? request.context.topic : undefined;
  const opening = topic ? `Thinking about ${topic}: ` : "";
  return `${opening}you said “${(lastLearnerTurn?.content ?? "").slice(0, 200)}”. `
    + "What makes you say that? Try explaining your reasoning step by step — I'll follow up on whatever you find hardest. "
    + "(This is the built-in demo coach: no provider is configured for this endpoint yet, so replies are canned.)";
}

/** What the relay accepts back from a provider: a reply string under one of the obvious keys. */
function replyFrom(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const candidate = (body as { reply?: unknown; content?: unknown; message?: unknown }).reply
    ?? (body as { content?: unknown }).content
    ?? (body as { message?: unknown }).message;
  return typeof candidate === "string" && candidate.length > 0 ? candidate.slice(0, 8000) : undefined;
}

export function registerRelayRoutes(app: FastifyInstance, ring: SigningKeyRing, options: RelayOptions = {}): void {
  const issuer = (options.issuer ?? process.env.RUNTIME_PUBLIC_ISSUER ?? "http://localhost:3000").replace(/\/$/, "");
  const endpoints = options.endpoints ?? endpointsFromEnvironment();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const perMinute = options.perMinute ?? 30;
  const correlation = (req: { correlationId?: string; headers: Record<string, unknown> }): string =>
    req.correlationId ?? (typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID());

  // Under route `config`, where @fastify/rate-limit (registered global: false) actually looks —
  // a top-level rateLimit shorthand is silently ignored and the route would run unlimited.
  app.post("/api/v1/relay/coach/messages", { config: { rateLimit: { max: perMinute, timeWindow: "1 minute" } } }, async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; body: unknown; correlationId?: string };
    const correlationValue = correlation(request);

    let descriptor;
    try {
      const header = request.headers.authorization;
      descriptor = await verifyDescriptor(typeof header === "string" ? header.replace(/^Bearer /, "") : "", ring, issuer);
    } catch {
      return sendProblem(reply, "SESSION_EXPIRED", correlationValue, 401);
    }

    const parsed = coachRelayRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, "RELAY_REQUEST_INVALID", descriptor.correlation_id, 400);
    const body = parsed.data;

    if (body.endpoint === "demo" && !endpoints.demo) {
      return reply.code(200).send({ endpoint: "demo", reply: demoReply(body), correlation_id: descriptor.correlation_id });
    }

    const endpoint = endpoints[body.endpoint];
    if (!endpoint) return sendProblem(reply, "RELAY_ENDPOINT_UNKNOWN", descriptor.correlation_id, 404);

    // What the provider learns about the learner: a pseudonym and the attempt identifiers — the
    // same facts every xAPI statement already carries — and the conversation itself. Never a name,
    // never a token, never the descriptor.
    const outbound = {
      attempt_id: descriptor.attempt_id,
      object_id: descriptor.object_id,
      pseudonym: descriptor.sub,
      correlation_id: descriptor.correlation_id,
      messages: body.messages,
      context: body.context ?? {},
    };

    // One timer covers the whole exchange, body included: a provider that returns headers promptly
    // and then stalls mid-body would otherwise hold this connection forever — the abort signal has
    // to stay armed until the reply is fully read.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.authorization ? { authorization: endpoint.authorization } : {}),
        },
        body: JSON.stringify(outbound),
        signal: controller.signal,
      });
      if (!response.ok) return sendProblem(reply, "RELAY_UPSTREAM_FAILED", descriptor.correlation_id, 502);
      const answer = replyFrom(await response.json().catch(() => undefined));
      if (!answer) return sendProblem(reply, "RELAY_UPSTREAM_FAILED", descriptor.correlation_id, 502);
      return reply.code(200).send({ endpoint: body.endpoint, reply: answer, correlation_id: descriptor.correlation_id });
    } catch {
      return sendProblem(reply, "RELAY_UPSTREAM_FAILED", descriptor.correlation_id, 502);
    } finally {
      clearTimeout(timer);
    }
  });
}
