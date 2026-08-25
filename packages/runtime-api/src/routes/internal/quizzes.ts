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

const IDEMPOTENCY_TTL_MS = Number.parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "86400000", 10);

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
    const replayed = await ctx.store.replayIdempotent("internal-quiz", idempotencyKey, "");
    if (replayed) {
      return (reply as { code: (n: number) => { send: (b: unknown) => unknown } })
        .code(201).send({ ...(replayed.response as object), correlation_id: correlation, replayed: true });
    }

    const draft = quizDraftSchema.safeParse(request.body);
    if (!draft.success) return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlation, 400);

    const registered = await ctx.catalogue.registerQuiz(draft.data, { authored_by: "mcp-connector" });
    await ctx.store.recordIdempotent("internal-quiz", idempotencyKey, "", 201, registered, IDEMPOTENCY_TTL_MS);
    return (reply as { code: (n: number) => { send: (b: unknown) => unknown } })
      .code(201).send({ ...registered, correlation_id: correlation, replayed: false });
  });
}
