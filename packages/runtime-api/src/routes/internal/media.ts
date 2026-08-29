/**
 * Internal service surface for registering authored video, document, and audio *content* as
 * learning objects — the media analogue of internal/quizzes.ts.
 *
 * As with quizzes, there is no code-upload path here: a caller supplies a structured JSON draft
 * (for a document, one that already carries pre-rasterised page image URLs — see
 * packages/document-converter for how those get produced), never a bundle, so registering media
 * adds no executable surface to the catalogue.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audioDraftSchema, documentDraftSchema, videoDraftSchema } from "../../../../contracts/src/index.js";
import type { CatalogueStore } from "../../catalogue/index.js";
import type { MediaKind } from "../../catalogue/types.js";
import type { RuntimeStore } from "../../store/index.js";
import { sendProblem } from "../../services/problem.js";
import { requestFingerprint, withIdempotencyClaim } from "../../services/idempotency.js";

const correlationOf = (req: { correlationId?: string; headers: Record<string, unknown> }): string =>
  req.correlationId ?? (typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID());

export interface InternalMediaContext {
  store: RuntimeStore;
  catalogue: CatalogueStore;
}

const DRAFT_SCHEMAS = { video: videoDraftSchema, document: documentDraftSchema, audio: audioDraftSchema } as const;
const ROUTE_PATHS: Record<MediaKind, string> = {
  video: "/api/v1/internal/runtime/videos",
  document: "/api/v1/internal/runtime/documents",
  audio: "/api/v1/internal/runtime/audio",
};

export function registerInternalMediaRoutes(
  app: FastifyInstance,
  guard: (req: FastifyRequest, reply: FastifyReply, correlation: string) => boolean,
  ctx: InternalMediaContext,
) {
  for (const kind of Object.keys(DRAFT_SCHEMAS) as MediaKind[]) {
    app.post(ROUTE_PATHS[kind], async (req, reply) => {
      const request = req as { headers: Record<string, unknown>; body: unknown; correlationId?: string };
      const correlation = correlationOf(request);
      if (!guard(req, reply, correlation)) return;

      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlation, 400);
      }
      const send = (status: number, body: unknown) =>
        (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send(body);

      return withIdempotencyClaim(ctx.store, `internal-${kind}`, idempotencyKey, requestFingerprint(request.body), {
        mismatch: () => sendProblem(reply, "IDEMPOTENCY_KEY_REUSED", correlation, 409),
        inFlight: () => sendProblem(reply, "IDEMPOTENCY_KEY_IN_FLIGHT", correlation, 409),
        replay: (status, response) => send(status, { ...(response as object), correlation_id: correlation, replayed: true }),
        run: async (complete) => {
          const draft = DRAFT_SCHEMAS[kind].safeParse(request.body);
          if (!draft.success) return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlation, 400);

          const registered = await ctx.catalogue.registerMedia(kind, draft.data, { authored_by: "mcp-connector" });
          await complete(201, registered);
          return send(201, { ...registered, correlation_id: correlation, replayed: false });
        },
      });
    });
  }
}
