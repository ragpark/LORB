/**
 * The Evidence API.
 *
 * Accepts xAPI statements from a launched player, binds each one to the actor the launch descriptor
 * names, and records it in the durable outbox for the forwarder to deliver to the learning record
 * store. Acceptance and delivery are separated on purpose: the learner's activity must not depend on
 * the learning record store being reachable at that moment, and a statement that was accepted must
 * never be lost because delivery failed.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { xapiStatementSchema } from "../../contracts/src/index.js";
import { verifyDescriptor, type SigningKeyRing } from "../../runtime-api/src/core.js";
import { store as defaultStore, type RuntimeStore } from "../../runtime-api/src/store/index.js";
import { metrics } from "../../runtime-api/src/services/observability.js";
import { sendProblem } from "../../runtime-api/src/services/problem.js";
import { activityObjectId, aggregateActivityResults } from "./read-model.js";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export interface EvidenceOptions {
  issuer?: string;
  store?: RuntimeStore;
}

export function registerEvidenceRoutes(app: FastifyInstance, ring: SigningKeyRing, options: EvidenceOptions = {}): void {
  const issuer = (options.issuer ?? process.env.RUNTIME_PUBLIC_ISSUER ?? "http://localhost:3000").replace(/\/$/, "");
  const store = options.store ?? defaultStore();
  const correlation = (req: { correlationId?: string; headers: Record<string, unknown> }): string =>
    req.correlationId ?? (typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID());

  app.post("/api/v1/evidence/statements", async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; body: unknown; correlationId?: string };
    const correlationValue = correlation(request);
    if (typeof request.headers["idempotency-key"] !== "string") {
      return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationValue, 400);
    }

    let descriptor;
    try {
      const header = request.headers.authorization;
      descriptor = await verifyDescriptor(typeof header === "string" ? header.replace(/^Bearer /, "") : "", ring, issuer);
    } catch {
      metrics.evidenceAccepted.inc({ outcome: "unauthenticated" });
      return sendProblem(reply, "SESSION_EXPIRED", correlationValue, 401);
    }

    const parsed = xapiStatementSchema.safeParse(request.body);
    if (!parsed.success) {
      metrics.evidenceAccepted.inc({ outcome: "invalid" });
      return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", descriptor.correlation_id, 400);
    }
    const statement = parsed.data;

    // Evidence actor binding: a player may only speak for the pseudonym its own descriptor names.
    if (statement.actor.account.name !== descriptor.sub) {
      metrics.evidenceAccepted.inc({ outcome: "actor_mismatch" });
      return sendProblem(reply, "ACCESS_DENIED", descriptor.correlation_id, 403);
    }
    // ...and only about the attempt it was launched for.
    if (statement.context.extensions["https://lorb.example/xapi/attempt_id"] !== descriptor.attempt_id) {
      metrics.evidenceAccepted.inc({ outcome: "attempt_mismatch" });
      return sendProblem(reply, "ACCESS_DENIED", descriptor.correlation_id, 403);
    }

    // The statement UUID is the deduplication key, so a retried delivery has no second business
    // effect. A duplicate is accepted, not rejected: the client's retry succeeded the first time.
    const accepted = await store.enqueueStatement({
      outbox_id: randomUUID(),
      statement_id: statement.id,
      repository_id: descriptor.repository_id,
      attempt_id: descriptor.attempt_id,
      package_version_id: descriptor.package_version_id,
      object_id: activityObjectId(statement.object.id) ?? descriptor.object_id,
      actor_pseudonym: statement.actor.account.name,
      verb_id: statement.verb.id,
      payload: statement,
      created_at: new Date().toISOString(),
      correlation_id: descriptor.correlation_id,
    });
    metrics.evidenceAccepted.inc({ outcome: accepted ? "accepted" : "duplicate" });
    return (reply as { code: (n: number) => { send: (b: unknown) => unknown } })
      .code(202).send({ statement_id: statement.id, status: "PENDING", duplicate: !accepted, correlation_id: descriptor.correlation_id });
  });

  app.get("/api/v1/evidence/outbox", async (req) => {
    const request = req as { query: { status?: string; object_id?: string }; headers: Record<string, unknown>; correlationId?: string };
    return {
      items: await store.listOutbox({ status: request.query.status as never, object_id: request.query.object_id }),
      next_cursor: null,
      correlation_id: correlation(request),
    };
  });

  app.get("/api/v1/evidence/outbox/:outboxId", async (req, reply) => {
    const request = req as { params: { outboxId: string }; headers: Record<string, unknown>; correlationId?: string };
    const row = await store.getOutbox(request.params.outboxId);
    return row ?? sendProblem(reply, "OBJECT_NOT_FOUND", correlation(request));
  });

  /**
   * Requeues a failed or dead-lettered statement. The caller must name the statement id it expects,
   * so a replay cannot be aimed at whatever happens to be in that outbox slot; and the statement is
   * requeued with its original identifier, so replaying it a second time still has one business
   * effect rather than two.
   */
  app.post("/api/v1/evidence/outbox/:outboxId/replay", async (req, reply) => {
    const request = req as { params: { outboxId: string }; body: { statement_id?: string }; headers: Record<string, unknown>; correlationId?: string };
    const correlationValue = correlation(request);
    if (typeof request.headers["idempotency-key"] !== "string") {
      return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationValue, 400);
    }
    const statementId = request.body?.statement_id;
    if (typeof statementId !== "string" || !UUID.test(statementId)) {
      return sendProblem(reply, "ATTEMPT_CONFLICT", correlationValue, 409);
    }
    const requeued = await store.requeueStatement(request.params.outboxId, statementId);
    if (!requeued) return sendProblem(reply, "ATTEMPT_CONFLICT", correlationValue, 409);
    return (reply as { code: (n: number) => { send: (b: unknown) => unknown } })
      .code(202).send({ outbox_id: request.params.outboxId, statement_id: statementId, status: "PENDING", correlation_id: correlationValue });
  });

  /**
   * Teacher-facing aggregation for one learning object. Returns pseudonyms only: resolving a
   * pseudonym back to a named learner is a concern for the caller that holds the roster.
   */
  app.get("/api/v1/evidence/activity-results", async (req, reply) => {
    const request = req as { query: { object_id?: string }; headers: Record<string, unknown>; correlationId?: string };
    const correlationValue = correlation(request);
    const objectId = request.query?.object_id;
    if (typeof objectId !== "string" || !UUID.test(objectId)) {
      return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlationValue, 400);
    }
    return { ...(await aggregateActivityResults(objectId, store)), correlation_id: correlationValue };
  });
}

export async function buildEvidence(ring: SigningKeyRing, issuer?: string, store?: RuntimeStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerEvidenceRoutes(app, ring, { issuer, store });
  return app;
}
