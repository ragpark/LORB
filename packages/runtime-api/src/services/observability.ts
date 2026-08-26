/**
 * Logging, metrics and correlation.
 *
 * Two anti-requirements shape this module and neither is optional: no learner-entered content in
 * logs or traces, and no treating the hosting platform's own log stream as sufficient observability.
 * So logs are structured and redacted at the serialiser rather than at each call site — a redaction
 * that depends on every caller remembering it is a redaction that will leak — and the service
 * exposes its own metrics rather than relying on request logs to be scraped.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pino, type Logger } from "pino";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const CORRELATION_HEADER = "x-correlation-id";
const TRACEPARENT_HEADER = "traceparent";

/**
 * Header and body paths that must never be written out. `authorization` and the descriptor carry
 * bearer material; `state_payload` and `payload` carry whatever the learner typed.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["idempotency-key"]',
  "req.body.state_payload",
  "req.body.payload",
  "req.body.questions",
  "req.body.learners",
  "res.headers['set-cookie']",
  "descriptor",
  "signed_descriptor",
  "access_token",
  "token",
  "password",
  "secret",
];

let rootLogger: Logger | undefined;

export function logger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      base: {
        service: process.env.SERVICE_NAME ?? "lorb-runtime",
        environment: process.env.NODE_ENV ?? "development",
        version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
      },
      formatters: { level: (label) => ({ level: label }) },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return rootLogger;
}

export const metricsRegistry = new Registry();
let defaultsCollected = false;

export function ensureDefaultMetrics(): void {
  if (defaultsCollected) return;
  defaultsCollected = true;
  collectDefaultMetrics({ register: metricsRegistry, prefix: "lorb_" });
}

const counter = (name: string, help: string, labelNames: string[]) => {
  const existing = metricsRegistry.getSingleMetric(name);
  return (existing as Counter<string>) ?? new Counter({ name, help, labelNames, registers: [metricsRegistry] });
};

const histogram = (name: string, help: string, labelNames: string[], buckets: number[]) => {
  const existing = metricsRegistry.getSingleMetric(name);
  return (existing as Histogram<string>) ?? new Histogram({ name, help, labelNames, buckets, registers: [metricsRegistry] });
};

export const metrics = {
  httpRequests: counter("lorb_http_requests_total", "HTTP requests handled", ["method", "route", "status"]),
  httpDuration: histogram("lorb_http_request_duration_seconds", "HTTP request duration", ["method", "route"], [0.01, 0.05, 0.15, 0.4, 0.75, 1.5, 5]),
  launches: counter("lorb_launches_total", "Launch descriptors issued", ["outcome", "source"]),
  attemptTransitions: counter("lorb_attempt_transitions_total", "Attempt lifecycle transitions", ["to", "outcome"]),
  evidenceAccepted: counter("lorb_evidence_statements_total", "xAPI statements accepted by the Evidence API", ["outcome"]),
  evidenceForwarded: counter("lorb_evidence_forwarded_total", "xAPI statements delivered to the learning record store", ["outcome"]),
  evidenceLag: histogram("lorb_evidence_delivery_seconds", "Seconds between accepting a statement and delivering it", [], [0.5, 1, 2, 5, 15, 60, 300, 1800]),
  smartLinkRedemptions: counter("lorb_smart_link_redemptions_total", "Smart link redemptions", ["outcome"]),
};

/** The correlation identifier for this request: the client's if it supplied a usable one, else new. */
export function correlationId(req: { headers: Record<string, unknown> }): string {
  const supplied = req.headers[CORRELATION_HEADER];
  if (typeof supplied === "string" && /^[\w.:-]{8,128}$/.test(supplied)) return supplied;
  return randomUUID();
}

/**
 * Installs request logging, correlation propagation and HTTP metrics.
 *
 * The route label comes from Fastify's matched route rather than the raw URL, so a metric series
 * cannot be created per attempt identifier — an unbounded label set is how a metrics endpoint
 * becomes an outage.
 */
export function registerObservability(app: FastifyInstance, options: { metricsEnabled: boolean } = { metricsEnabled: true }): void {
  const log = logger();
  ensureDefaultMetrics();

  app.decorateRequest("correlationId", "");
  app.decorateRequest("startedAt", 0);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const correlation = correlationId(req as never);
    (req as never as { correlationId: string }).correlationId = correlation;
    (req as never as { startedAt: number }).startedAt = process.hrtime.bigint ? Number(process.hrtime.bigint() / 1000000n) : Date.now();
    reply.header(CORRELATION_HEADER, correlation);
    const traceparent = req.headers[TRACEPARENT_HEADER];
    if (typeof traceparent === "string") reply.header(TRACEPARENT_HEADER, traceparent);
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const route = (req as never as { routeOptions?: { url?: string } }).routeOptions?.url ?? "unmatched";
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    if (options.metricsEnabled) {
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    }
    // The URL is not logged: attempt and object identifiers in a path are operational data, but a
    // query string is where a caller's own parameters end up, and those are not ours to keep.
    log.info({
      correlation_id: (req as never as { correlationId: string }).correlationId,
      method: req.method,
      route,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    }, "request");
  });

  app.setErrorHandler((error, req, reply) => {
    log.error({
      correlation_id: (req as never as { correlationId: string }).correlationId,
      route: (req as never as { routeOptions?: { url?: string } }).routeOptions?.url ?? "unmatched",
      err: { type: error.name, message: error.message, code: (error as { code?: string }).code },
    }, "request failed");
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    void reply.code(status).type("application/problem+json").send({
      type: "https://lorb.example/errors/UNKNOWN_ERROR",
      title: "We could not complete that request",
      status,
      code: status === 429 ? "RATE_LIMITED" : "UNKNOWN_ERROR",
      detail: "Please try again shortly.",
      correlation_id: (req as never as { correlationId: string }).correlationId,
      retryable: status >= 500 || status === 429,
      field_errors: [],
    });
  });
}
