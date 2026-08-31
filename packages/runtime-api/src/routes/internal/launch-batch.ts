/**
 * Internal service surface for assigning one learning object to a set of learners.
 *
 * It exists so one internal caller can record an assignment for a whole class from a single request
 * instead of impersonating one login per learner. Learners are converted to LORB pseudonyms with
 * exactly the function, secret, issuer and purpose the authenticated launch path uses, so a
 * learner's assignment and that learner's own login resolve to one actor — and the platform
 * identifiers themselves are returned to the caller once and never persisted here.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { issueDescriptor, sessionExpiresAt, signLtiLoginHint, type SigningKeyRing } from "../../core.js";
import { requestFingerprint, withIdempotencyClaim } from "../../services/idempotency.js";
import { computePseudonym } from "../../services/pseudonym-service.js";
import { sendProblem } from "../../services/problem.js";
import type { CatalogueStore } from "../../catalogue/index.js";
import type { RuntimeStore } from "../../store/index.js";


export interface LaunchBatchContext {
  serviceToken: string | undefined;
  ring: SigningKeyRing;
  ltiRing: SigningKeyRing;
  secret: Buffer;
  /** The issuer whose subjects these learner identifiers belong to. */
  identityIssuer: string;
  publicIssuer: string;
  playerOrigin: string;
  evidenceEndpoint: string;
  store: RuntimeStore;
  catalogue: CatalogueStore;
}

const launchBatchSchema = z.object({
  object_id: z.string().uuid(),
  learners: z.array(z.object({ learner_id: z.string().min(1).max(128).regex(/^[A-Za-z\d._:-]+$/) }).strict()).min(1).max(500),
  // Opt-in. When false (the default) the batch records the assignment and returns pseudonyms only;
  // learners then launch through the normal consumer flow, which mints their descriptor at the
  // moment they open the activity. Descriptors live minutes, so pre-minting them for a whole class
  // is only useful to a caller about to drive those launches immediately.
  include_descriptors: z.boolean().optional(),
}).strict();

const correlationOf = (req: { correlationId?: string; headers: Record<string, unknown> }): string =>
  req.correlationId ?? (typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID());

export function registerInternalLaunchBatchRoutes(
  app: FastifyInstance,
  ctx: LaunchBatchContext,
  guard: (req: FastifyRequest, reply: FastifyReply, correlation: string) => boolean,
) {
  app.post("/api/v1/internal/runtime/launch-batch", async (req, reply) => {
    const request = req as { headers: Record<string, unknown>; body: unknown; correlationId?: string };
    const correlation = correlationOf(request);
    if (!guard(req, reply, correlation)) return;

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return sendProblem(reply, "IDEMPOTENCY_KEY_REQUIRED", correlation, 400);
    }
    const send = (status: number, body: unknown) =>
      (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send(body);

    // Claimed before any assignment is written. A retry that overlapped the original used to create
    // a second assignment and a second set of attempts for the same class.
    return withIdempotencyClaim(ctx.store, "internal-launch-batch", idempotencyKey, requestFingerprint(request.body), {
      mismatch: () => sendProblem(reply, "IDEMPOTENCY_KEY_REUSED", correlation, 409),
      inFlight: () => sendProblem(reply, "IDEMPOTENCY_KEY_IN_FLIGHT", correlation, 409),
      replay: (status, response) => send(status, { ...(response as object), correlation_id: correlation, replayed: true }),
      run: async (complete) => {
        const parsed = launchBatchSchema.safeParse(request.body);
        if (!parsed.success) return sendProblem(reply, "LAUNCH_CONTEXT_INVALID", correlation, 400);

        const object = await ctx.catalogue.learningObject(parsed.data.object_id);
        if (!object) return sendProblem(reply, "OBJECT_NOT_FOUND", correlation, 404);
        if (object.status !== "PUBLISHED") return sendProblem(reply, "LEARNING_OBJECT_NOT_AVAILABLE", correlation, 409);

        const assignmentId = randomUUID();
        const createdAt = new Date().toISOString();
        const seen = new Set<string>();
        const learners: Record<string, unknown>[] = [];

        for (const learner of parsed.data.learners) {
          const pseudonym = computePseudonym(ctx.secret, ctx.identityIssuer, learner.learner_id, "launch");
          if (seen.has(pseudonym)) continue;
          seen.add(pseudonym);
          const entry: Record<string, unknown> = { learner_id: learner.learner_id, pseudonym };

          if (parsed.data.include_descriptors) {
            const attemptId = randomUUID();
            const expiresAt = sessionExpiresAt();
            await ctx.store.createAttempt({
              attempt_id: attemptId,
              repository_id: object.repository_id,
              object_id: object.object_id,
              object_version_id: object.active_object_version_id,
              package_version_id: object.active_package_version_id,
              pseudonym,
              consumer_id: "internal-assignment",
              status: "CREATED",
              revision: 1,
              correlation_id: correlation,
              created_at: createdAt,
              expires_at: expiresAt,
              source: "assignment",
            });
            const descriptor = await issueDescriptor(ctx.ring, {
              sub: pseudonym,
              repository_id: object.repository_id,
              consumer_id: "internal-assignment",
              object_id: object.object_id,
              object_version_id: object.active_object_version_id,
              package_version_id: object.active_package_version_id,
              correlation_id: randomUUID(),
              locale: "en-GB",
              attempt_id: attemptId,
              state_endpoint: `${ctx.publicIssuer}/api/v1/runtime/attempts/${attemptId}/state`,
              package_url: `${ctx.playerOrigin}${object.module_path}`,
              session_config: { expires_at: expiresAt },
              content_profile: object.content_profile,
            }, { issuer: ctx.publicIssuer, evidenceEndpoint: ctx.evidenceEndpoint });
            const launchId = randomUUID();
            await ctx.store.recordLaunch({
              launch_id: launchId, attempt_id: attemptId, repository_id: object.repository_id,
              object_id: object.object_id, consumer_id: "internal-assignment",
              launch_mode: "embedded-iframe", expires_at: expiresAt, correlation_id: correlation,
            });
            const hashParams = new URLSearchParams({ descriptor });
            if (object.content_profile === "lti-tool-v1") {
              hashParams.set("lti_login_hint", await signLtiLoginHint(ctx.ltiRing, { sub: pseudonym, object_id: object.object_id, attempt_id: attemptId }, ctx.publicIssuer));
            }
            Object.assign(entry, {
              launch_id: launchId,
              attempt_id: attemptId,
              signed_descriptor: descriptor,
              player_url: `${ctx.playerOrigin}/#${hashParams.toString()}`,
              expires_at: expiresAt,
            });
          }
          learners.push(entry);
        }

        await ctx.store.recordAssignment({
          assignment_id: assignmentId,
          object_id: object.object_id,
          created_at: createdAt,
          source: "internal-launch-batch",
          pseudonyms: [...seen],
        });

        const response = { assignment_id: assignmentId, object_id: object.object_id, assigned_count: learners.length, created_at: createdAt, learners };
        await complete(201, response);
        return send(201, { ...response, correlation_id: correlation, replayed: false });
      },
    });
  });
}
