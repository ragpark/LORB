// NEW INTERNAL TRUST BOUNDARY — NOT PRODUCTION — BLOCKED BY BLK-02, BLK-03, BLK-08. See service-auth.ts.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { KeyLike } from "jose";
import type { FastifyInstance } from "fastify";
import { issueDescriptor, store } from "../../core.js";
import { computePseudonym } from "../../services/pseudonym-service.js";
import { learningObjectById } from "../../services/catalogue.js";

export interface LaunchBatchContext {
  serviceToken: string | undefined;
  privateKey: KeyLike;
  secret: Buffer;
  iesIssuer: string;
  publicIssuer: string;
  playerOrigin: string;
  evidenceEndpoint: string;
}

const launchBatchSchema = z.object({
  object_id: z.string().uuid(),
  // Platform learner identifiers, in the shape the upstream identity source issues. They are
  // converted to LORB pseudonyms below and are never persisted by the Runtime API.
  learners: z.array(z.object({ learner_id: z.string().min(1).max(128).regex(/^[A-Za-z\d._:-]+$/) }).strict()).min(1).max(200),
  // Opt-in. When false (the default) the batch records the assignment and returns pseudonyms only;
  // learners then launch through the normal consumer + IES flow, which mints their descriptor at the
  // moment they open the activity. Descriptors live 600 seconds, so pre-minting them for a whole
  // class is only useful to a caller that is about to drive those launches immediately.
  include_descriptors: z.boolean().optional(),
}).strict();

const correlationOf = (req: any): string =>
  typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : randomUUID();

const problem = (reply: any, code: string, status: number, correlation_id: string) =>
  reply.code(status).type("application/problem+json").send({
    type: `https://lorb.example/errors/${code}`, title: "We could not complete that request", status, code,
    detail: "Please check the request and try again", correlation_id, retryable: status >= 500, field_errors: [],
  });

export function registerInternalLaunchBatchRoutes(app: FastifyInstance, ctx: LaunchBatchContext, guard: (req: any, reply: any, correlation: string) => boolean) {
  app.post("/api/v1/internal/runtime/launch-batch", async (req: any, reply: any) => {
    const correlation = correlationOf(req);
    if (!guard(req, reply, correlation)) return;
    const idem = req.headers["idempotency-key"];
    if (typeof idem !== "string" || idem.length === 0) return problem(reply, "IDEMPOTENCY_KEY_REQUIRED", 400, correlation);
    const key = `internal-launch-batch:${idem}`;
    const replayed = store.idempotency.get(key);
    if (replayed) return reply.code(201).send({ ...(replayed as object), correlation_id: correlation, replayed: true });

    const parsed = launchBatchSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, "LAUNCH_CONTEXT_INVALID", 400, correlation);
    const object = learningObjectById.get(parsed.data.object_id);
    if (!object) return problem(reply, "OBJECT_NOT_FOUND", 404, correlation);
    if (object.status !== "PUBLISHED") return problem(reply, "LEARNING_OBJECT_NOT_AVAILABLE", 409, correlation);

    const assignment_id = randomUUID();
    const created_at = new Date().toISOString();
    const seen = new Set<string>();
    const learners: Array<Record<string, unknown>> = [];
    for (const learner of parsed.data.learners) {
      // Exactly the pseudonymisation the IES-authenticated launch path uses — same secret, same
      // issuer, same purpose — so a batch-assigned learner and that learner's own IES login resolve
      // to one actor. No second, raw-identifier actor scheme is introduced.
      const pseudonym = computePseudonym(ctx.secret, ctx.iesIssuer, learner.learner_id, "launch");
      if (seen.has(pseudonym)) continue;
      seen.add(pseudonym);
      const entry: Record<string, unknown> = { learner_id: learner.learner_id, pseudonym };
      if (parsed.data.include_descriptors) {
        const attempt_id = randomUUID(), object_version_id = randomUUID();
        const package_version_id = object.active_package_version_id;
        store.attempts.set(attempt_id, { attempt_id, repository_id: object.repository_id, object_version_id, package_version_id, pseudonym, status: "CREATED", revision: 1 });
        const expires_at = new Date(Date.now() + 600000).toISOString();
        const descriptor = await issueDescriptor(ctx.privateKey, {
          sub: pseudonym, repository_id: object.repository_id, consumer_id: "internal-assignment", object_id: object.object_id,
          object_version_id, package_version_id, correlation_id: randomUUID(), locale: "en-GB", attempt_id,
          state_endpoint: `${ctx.publicIssuer}/api/v1/runtime/attempts/${attempt_id}/state`,
          package_url: `${ctx.playerOrigin}${object.module_path}`, session_config: { expires_at },
        }, { issuer: ctx.publicIssuer, evidenceEndpoint: ctx.evidenceEndpoint });
        const launch_id = randomUUID();
        const launch = { launch_id, attempt_id, signed_descriptor: descriptor, player_url: `${ctx.playerOrigin}/#descriptor=${encodeURIComponent(descriptor)}`, expires_at };
        store.launches.set(launch_id, { ...launch, correlation_id: correlation });
        Object.assign(entry, launch);
      }
      learners.push(entry);
    }

    store.assignments.set(assignment_id, { assignment_id, object_id: object.object_id, created_at, source: "internal-launch-batch", pseudonyms: [...seen] });
    const response = { assignment_id, object_id: object.object_id, assigned_count: learners.length, created_at, learners };
    store.idempotency.set(key, response);
    return reply.code(201).send({ ...response, correlation_id: correlation, replayed: false });
  });
}
