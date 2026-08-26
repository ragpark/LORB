/**
 * Internal service surface for registering authored quiz *content* as a learning object.
 *
 * It accepts structured JSON bound to the fixed, already-reviewed quiz-player package version. There
 * is no code-upload path here by design: a caller supplies questions, never a bundle, so registering
 * a quiz adds no executable surface to the catalogue.
 *
 * Authentication is the internal service credential — see service-auth.ts for why that is a distinct
 * trust domain from both the learner and the administrator surfaces.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { quizDraftSchema } from "../../../../contracts/src/index.js";
import type { CatalogueStore } from "../../catalogue/index.js";
import type { RuntimeStore } from "../../store/index.js";
import { sendProblem } from "../../services/problem.js";
import { requestFingerprint, withIdempotencyClaim } from "../../services/idempotency.js";


const correlationOf = (req: { correlationId?: string; headers: Record<string, unknown> }): string =>
  req.correlationId ?? (typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID());

export interface InternalQuizContext {
  store: RuntimeStore;
  catalogue: CatalogueStore;
}

export function registerInternalQuizRoutes(
  app: FastifyInstance,
  guard: (req: FastifyRequest, reply: FastifyReply, correlation: string) => boolean,
  ctx: InternalQuizContext,
) {
  app.post("/api/v1/internal/runtime/quizzes", async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; body: unknown; correlationId?: string };
    const correlation = correlationOf(request);
    if (!guard(req, reply, correlation)) return;

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlation, 400);
    }
    const send = (status: number, body: unknown) =>
      (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send(body);

    // Claimed before the quiz is registered. Checking for a stored response first and writing one
    // afterwards let a retry that overlapped the original register a second learning object.
    return withIdempotencyClaim(ctx.store, "internal-quiz", idempotencyKey, requestFingerprint(request.body), {
      mismatch: () => sendProblem(reply, "IDEMPOTENCY_KEY_REUSED", correlation, 409),
      inFlight: () => sendProblem(reply, "IDEMPOTENCY_KEY_IN_FLIGHT", correlation, 409),
      replay: (status, response) => send(status, { ...(response as object), correlation_id: correlation, replayed: true }),
      run: async (complete) => {
        const draft = quizDraftSchema.safeParse(request.body);
        if (!draft.success) return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlation, 400);

        const registered = await ctx.catalogue.registerQuiz(draft.data, { authored_by: "mcp-connector" });
        await complete(201, registered);
        return send(201, { ...registered, correlation_id: correlation, replayed: false });
      },
    });
  });
}
