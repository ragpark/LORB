// NEW INTERNAL TRUST BOUNDARY — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-08. See service-auth.ts.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { quizDraftSchema } from "../../../../contracts/src/index.js";
import { registerQuizObject } from "../../services/catalogue.js";
import { store } from "../../core.js";
const correlationOf = (req: any): string =>
  typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID();

const invalid = (reply: any, code: string, status: number, correlation_id: string) =>
  reply.code(status).type("application/problem+json").send({
    type: `https://lorb.example/errors/${code}`, title: "We could not complete that request", status, code,
    detail: "Please check the request and try again", correlation_id, retryable: status >= 500, field_errors: [],
  });

export function registerInternalQuizRoutes(app: FastifyInstance, guard: (req: any, reply: any, correlation: string) => boolean) {
  /**
   * Registers agent-authored quiz *content* as a new learning object bound to the fixed, already
   * reviewed quiz-player package version. It accepts structured JSON only; there is no code-upload
   * path here, by design.
   */
  app.post("/api/v1/internal/runtime/quizzes", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const idem = req.headers["idempotency-key"];
    if (typeof idem !== "string" || idem.length === 0) return invalid(reply, "IDEMPOTENCY_KEY_REQUIRED", 400, correlation);
    // LORB's own idempotency layer, namespaced so it cannot collide with a launch key.
    const key = `internal-quiz:${idem}`;
    const replayed = store.idempotency.get(key);
    if (replayed) return reply.code(201).send({ ...(replayed as object), correlation_id: correlation, replayed: true });
    const draft = quizDraftSchema.safeParse(req.body);
    if (!draft.success) return invalid(reply, "QUIZ_CONTENT_INVALID", 400, correlation);
    const registered = registerQuizObject(draft.data);
    store.idempotency.set(key, registered);
    return reply.code(201).send({ ...registered, correlation_id: correlation, replayed: false });
  });
}
