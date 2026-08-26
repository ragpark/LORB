/**
 * The Publisher API — registering, authoring, editing and withdrawing learning objects.
 *
 * This is how content gets into a production catalogue. Until recently the catalogue was three
 * constants compiled into the service, so "registering a learning object" meant editing and
 * redeploying — the single largest reason the platform could not be operated by anyone but its
 * authors. Registration fixed that; this surface finishes the job, because a catalogue an
 * administrator can only ever add to is barely more operable than one they cannot add to at all. A
 * title typed wrong stayed wrong, a quiz question with the marking key on the wrong option stayed
 * wrong, and an object registered by mistake stayed in the catalogue for good.
 *
 * Four rules are enforced here rather than left to the caller:
 *
 *   - A published package version is never modified in place. Publishing again creates a new
 *     immutable version and supersedes the previous one, so a descriptor that pinned the old version
 *     still describes what was actually delivered. Editing content follows the same rule: the
 *     questions a learner answered stay readable at the version they answered them at.
 *   - An edit may change what the catalogue *says* about an object — its title, description, stated
 *     duration and kind — and may never change what a launch *resolves to*. The module path, the
 *     integrity digest and the version chain are reachable only by publishing.
 *   - A module path is a path under the Player Shell origin, never an absolute URL. Accepting an
 *     arbitrary origin here would let a publisher point a launch at content nobody reviewed.
 *   - Deletion is for objects that were never delivered. Anything with an attempt or an assignment
 *     against it is retired instead: evidence outlives the catalogue, and a class result that
 *     resolves to nothing is worse than a retired object nobody can launch.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { quizDraftSchema } from "../../../../contracts/src/index.js";
import type { CatalogueStore, LearningObjectRow } from "../../catalogue/index.js";
import type { RuntimeStore } from "../../store/index.js";
import { requestFingerprint, withIdempotencyClaim } from "../../services/idempotency.js";
import { requireRepositoryMembership, type RepositoryRole } from "../../services/admin-authz.js";
import { adminDbPool } from "../../db/pool.js";
import {
  correlationOf, requireAdmin, requireAuthorised, requireIdempotencyKey, sendAdminError,
  type AdminPrincipal, type AdminRouteContext,
} from "../admin/shared.js";
import { withAdminTransaction, writeAudit } from "../admin/shared.js";
import type { AuditInput } from "../../services/audit-writer.js";

/**
 * A relative path with no scheme, no host, no traversal and no query. The shell resolves it against
 * its own origin, so anything that could escape that origin is refused.
 */
const modulePath = z.string()
  .min(2).max(300)
  .regex(/^\/[A-Za-z\d._~\-/]*$/, "module_path must be an absolute path under the player origin")
  .refine((value) => !value.includes(".."), "module_path must not contain a traversal segment")
  .refine((value) => !value.startsWith("//"), "module_path must not be a protocol-relative URL");

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256 = z.string().regex(/^[a-f\d]{64}$/i);
const kind = z.string().regex(/^[a-z][a-z\d-]{1,60}$/);

const registrationSchema = z.object({
  repository_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  duration: z.string().max(60).optional(),
  kind: kind.optional(),
  module_path: modulePath,
  semver,
  sha256,
}).strict();

const versionSchema = z.object({ semver, module_path: modulePath, sha256 }).strict();

/**
 * What an edit may say. Nothing here reaches a descriptor, and the absence of `module_path`,
 * `sha256` and `repository_id` is the point: a moved object is a different launch policy's problem,
 * and a repointed one is a new version.
 */
const metadataSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  duration: z.string().max(60).optional(),
  kind: kind.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "an edit must change something");

const quizAuthoringSchema = z.object({ repository_id: z.string().uuid().optional() })
  .catchall(z.unknown());

export interface PublisherContext {
  catalogue: CatalogueStore;
  /** Idempotency records live here; the publisher shares the runtime's, scoped per surface. */
  store: RuntimeStore;
  adminCtx: AdminRouteContext;
}

export function registerPublisherRoutes(app: FastifyInstance, ctx: PublisherContext): void {
  const send = (reply: unknown, status: number, body: unknown) =>
    (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send(body);

  /**
   * Every publisher mutation requires an idempotency key, and for a while requiring it was all it
   * did: the key was checked for presence and then ignored. A client that lost the response to a
   * registration and retried it registered the object twice; a retried version publication either
   * published a second version or failed on the semver constraint instead of replaying the first
   * answer. The key is now claimed before the write and completed with the response.
   */
  const idempotently = <T>(
    reply: unknown, correlation: string, scope: string, key: string, body: unknown,
    run: (complete: (status: number, response: unknown) => Promise<void>) => Promise<T>,
  ) =>
    withIdempotencyClaim(ctx.store, scope, key, requestFingerprint(body), {
      mismatch: () => sendAdminError(reply as never, "IDEMPOTENCY_KEY_REUSED", correlation) as unknown as T,
      inFlight: () => sendAdminError(reply as never, "IDEMPOTENCY_KEY_IN_FLIGHT", correlation) as unknown as T,
      replay: (status, response) => send(reply, status, response) as unknown as T,
      run,
    });

  /**
   * Repository-scoped authorisation for a publishing action.
   *
   * Membership is granted against a repository row, and those rows live in the administration
   * database alongside the catalogue. Where the catalogue is the in-process one — `pnpm dev` without
   * a database, and the test suites — there are no repository rows to hold a membership against, so
   * the administrator role the request already carries is the whole gate. A deployed catalogue is
   * always the Postgres one.
   */
  const authorised = async (
    req: FastifyRequest, reply: FastifyReply, principal: AdminPrincipal,
    actionType: string, repositoryId: string, targetId: string | undefined, minimum: RepositoryRole,
  ): Promise<boolean> => {
    if (ctx.catalogue.kind !== "postgres") return true;
    return requireAuthorised(req, reply, principal, actionType, "learning_object", targetId, () =>
      requireRepositoryMembership(adminDbPool(), repositoryId, principal, minimum));
  };

  /** Audit is written on its own transaction: a failure to record must not undo a published edit. */
  const audit = (entry: AuditInput) =>
    withAdminTransaction((client) => writeAudit(client, entry)).catch(() => undefined);

  const objectIdOf = (req: unknown) => (req as { params: { objectId: string } }).params.objectId;

  /**
   * Loads the object an action names and authorises the caller against its repository, replying with
   * the right refusal when either step fails.
   */
  const openObject = async (
    req: FastifyRequest, reply: FastifyReply, principal: AdminPrincipal, correlation: string,
    actionType: string, minimum: RepositoryRole,
  ): Promise<LearningObjectRow | undefined> => {
    const existing = await ctx.catalogue.learningObject(objectIdOf(req));
    if (!existing) {
      sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      return undefined;
    }
    const ok = await authorised(req, reply, principal, actionType, existing.repository_id, existing.object_id, minimum);
    return ok ? existing : undefined;
  };

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  app.get("/api/v1/publisher/learning-objects", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "publisher.list", "learning_object");
    if (!principal) return;
    const query = (req as { query: { repository_id?: string; status?: string } }).query;
    const objects = await ctx.catalogue.learningObjects({
      repository_id: query.repository_id,
      status: query.status as LearningObjectRow["status"] | undefined,
    });
    const packages = new Map((await ctx.catalogue.packageVersions()).map((row) => [row.package_version_id, row]));
    return {
      items: objects.map((object) => ({ ...object, package_version: packages.get(object.active_package_version_id) })),
      next_cursor: null,
      correlation_id: correlationOf(req),
    };
  });

  /** One object with the version chain an operator needs to read an edit against. */
  app.get("/api/v1/publisher/learning-objects/:objectId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.get", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const object = await openObject(req, reply, principal, correlation, "learning_object.get", "repository_reader");
    if (!object) return;
    const [versions, packages] = await Promise.all([
      ctx.catalogue.objectVersions(object.object_id),
      ctx.catalogue.packageVersions({ object_id: object.object_id }),
    ]);
    const active = await ctx.catalogue.packageVersion(object.active_package_version_id);
    return {
      ...object,
      package_version: active,
      versions,
      package_versions: packages,
      editable_content: object.content_profile === "quiz-json-v1",
      correlation_id: correlation,
    };
  });

  /**
   * The authored content behind a quiz, marking key included.
   *
   * Everywhere else the marking key is served only to the learner-facing content route, and that
   * restriction is deliberate. It cannot hold here: an author editing a quiz has to see which option
   * is the right one, or the only way to correct a mis-keyed question is to delete the quiz and type
   * it again. So it is served to an authenticated administrator with membership of the repository,
   * never cached, and the read itself is audited — the exposure is bounded and it leaves a record.
   */
  app.get("/api/v1/publisher/learning-objects/:objectId/content", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.content_read", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const object = await openObject(req, reply, principal, correlation, "learning_object.content_read", "repository_operator");
    if (!object) return;
    if (object.content_profile !== "quiz-json-v1") return sendAdminError(reply, "LEARNING_OBJECT_CONTENT_UNSUPPORTED", correlation);
    const content = await ctx.catalogue.content(object.object_id);
    if (!content) return sendAdminError(reply, "LEARNING_OBJECT_CONTENT_NOT_FOUND", correlation);
    await audit({
      actorPseudonym: principal.pseudonym, actorRole: principal.role,
      actionType: "learning_object.content_read", targetType: "learning_object", targetId: object.object_id,
      outcome: "ALLOWED", correlationId: correlation,
    });
    return reply.header("cache-control", "no-store").send({ ...content, correlation_id: correlation });
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  app.post("/api/v1/publisher/learning-objects", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.register", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, "publisher-register", idempotencyKey, body, async (complete) => {
      const parsed = registrationSchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

      const repository = await ctx.catalogue.repository(parsed.data.repository_id);
      if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
      if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);
      if (!await authorised(req, reply, principal, "learning_object.register", repository.repository_id, undefined, "repository_operator")) return;

      const object = await ctx.catalogue.registerObject({ ...parsed.data, authored_by: principal.pseudonym });
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.register", targetType: "learning_object", targetId: object.object_id,
        resultingState: { status: object.status, active_package_version_id: object.active_package_version_id },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...object, correlation_id: correlation };
      await complete(201, response);
      return send(reply, 201, response);
    });
  });

  /**
   * Authoring a quiz: structured questions bound to the fixed, already-reviewed quiz player.
   *
   * The same content model an agent publishes through the internal surface, reachable by a person.
   * No bundle is uploaded and none is accepted, so authoring a quiz adds no executable surface to
   * the catalogue however many an administrator writes.
   */
  app.post("/api/v1/publisher/learning-objects/quizzes", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.author_quiz", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, "publisher-author-quiz", idempotencyKey, body, async (complete) => {
      const envelope = quizAuthoringSchema.safeParse(body);
      if (!envelope.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const { repository_id: requestedRepository, ...rest } = envelope.data;
      const draft = quizDraftSchema.safeParse(rest);
      if (!draft.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

      const repository = requestedRepository
        ? await ctx.catalogue.repository(requestedRepository)
        : await ctx.catalogue.defaultRepository();
      if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
      if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);
      if (!await authorised(req, reply, principal, "learning_object.author_quiz", repository.repository_id, undefined, "repository_operator")) return;

      const registered = await ctx.catalogue.registerQuiz(draft.data, {
        repository_id: repository.repository_id,
        authored_by: principal.pseudonym,
      });
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.author_quiz", targetType: "learning_object", targetId: registered.object_id,
        resultingState: { question_count: registered.question_count, content_version: registered.content_version },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...registered, repository_id: repository.repository_id, correlation_id: correlation };
      await complete(201, response);
      return send(reply, 201, response);
    });
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /** Edits the catalogue entry. Never the version chain — see the module comment. */
  app.patch("/api/v1/publisher/learning-objects/:objectId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.update", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, `publisher-update:${objectId}`, idempotencyKey, body, async (complete) => {
      const parsed = metadataSchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const existing = await openObject(req, reply, principal, correlation, "learning_object.update", "repository_operator");
      if (!existing) return;
      if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlation);

      const updated = await ctx.catalogue.updateObject(existing.object_id, parsed.data);
      if (!updated) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.update", targetType: "learning_object", targetId: updated.object_id,
        priorState: { title: existing.title, description: existing.description, duration: existing.duration, kind: existing.kind },
        resultingState: { title: updated.title, description: updated.description, duration: updated.duration, kind: updated.kind },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...updated, correlation_id: correlation };
      await complete(200, response);
      return send(reply, 200, response);
    });
  });

  /**
   * Replaces an authored quiz's questions.
   *
   * The object keeps its identity — every assignment, smart link and class result already points at
   * it — and gets a new content version bound to a new object version. What the previous version's
   * learners saw stays readable at the version they were launched against.
   */
  app.put("/api/v1/publisher/learning-objects/:objectId/content", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.content_revise", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, `publisher-content:${objectId}`, idempotencyKey, body, async (complete) => {
      const draft = quizDraftSchema.safeParse(body);
      if (!draft.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const existing = await openObject(req, reply, principal, correlation, "learning_object.content_revise", "repository_operator");
      if (!existing) return;
      if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlation);
      if (existing.content_profile !== "quiz-json-v1") return sendAdminError(reply, "LEARNING_OBJECT_CONTENT_UNSUPPORTED", correlation);

      const revision = await ctx.catalogue.reviseQuizContent(existing.object_id, draft.data);
      if (!revision) return sendAdminError(reply, "LEARNING_OBJECT_CONTENT_UNSUPPORTED", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.content_revise", targetType: "learning_object", targetId: existing.object_id,
        priorState: { active_object_version_id: existing.active_object_version_id },
        // The questions themselves are not audited: the audit trail is read by more people than the
        // marking key should be, and the content version names exactly what changed.
        resultingState: { active_object_version_id: revision.object_version_id, content_version: revision.content_version, question_count: revision.question_count },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...revision, correlation_id: correlation };
      await complete(200, response);
      return send(reply, 200, response);
    });
  });

  app.post("/api/v1/publisher/learning-objects/:objectId/versions", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.publish_version", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);
    const body = (req as { body: unknown }).body;

    // Scoped by object as well as surface: the same key against two different objects is two
    // different requests, and must not replay one another's response.
    return idempotently(reply, correlation, `publisher-publish:${objectId}`, idempotencyKey, body, async (complete) => {
      const parsed = versionSchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

      const existing = await openObject(req, reply, principal, correlation, "learning_object.publish_version", "repository_operator");
      if (!existing) return;
      if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_NOT_PUBLISHED", correlation);
      // An authored quiz is data on a shared, already-reviewed player. Publishing a code package for
      // one would silently repoint it at a bundle that cannot read its content, so the edit it
      // actually wants — new questions — is the one offered instead.
      if (existing.content_profile === "quiz-json-v1") return sendAdminError(reply, "LEARNING_OBJECT_CONTENT_UNSUPPORTED", correlation);

      const updated = await ctx.catalogue.publishObjectVersion(objectId, parsed.data);
      if (!updated) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.publish_version", targetType: "learning_object", targetId: updated.object_id,
        priorState: { active_package_version_id: existing.active_package_version_id },
        resultingState: { active_package_version_id: updated.active_package_version_id },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...updated, correlation_id: correlation };
      await complete(201, response);
      return send(reply, 201, response);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle and removal
  // -------------------------------------------------------------------------

  type Lifecycle = { action: string; to: "PUBLISHED" | "SUSPENDED" | "RETIRED"; from: LearningObjectRow["status"][] };
  const lifecycles: Record<string, Lifecycle> = {
    // Suspending takes an object out of the catalogue without ending it; restoring puts it back.
    // Retirement is the end of the line, and does not reverse: a retired object's learners have
    // moved on, and a catalogue where retirement is undone is a catalogue nobody can reason about.
    suspend: { action: "learning_object.suspend", to: "SUSPENDED", from: ["PUBLISHED"] },
    restore: { action: "learning_object.restore", to: "PUBLISHED", from: ["SUSPENDED"] },
    retire: { action: "learning_object.retire", to: "RETIRED", from: ["PUBLISHED", "SUSPENDED", "DRAFT", "VALIDATING", "SUPERSEDED"] },
  };

  for (const [path, lifecycle] of Object.entries(lifecycles)) {
    app.post(`/api/v1/publisher/learning-objects/:objectId/${path}`, async (req, reply) => {
      const principal = await requireAdmin(req, reply, ctx.adminCtx, lifecycle.action, "learning_object");
      if (!principal) return;
      const correlation = correlationOf(req);
      const idempotencyKey = requireIdempotencyKey(req, reply);
      if (!idempotencyKey) return;
      const objectId = objectIdOf(req);

      return idempotently(reply, correlation, `publisher-${path}:${objectId}`, idempotencyKey, null, async (complete) => {
        const existing = await openObject(req, reply, principal, correlation, lifecycle.action, "repository_owner");
        if (!existing) return;
        if (!lifecycle.from.includes(existing.status)) return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlation);

        const updated = await ctx.catalogue.setObjectStatus(existing.object_id, lifecycle.to);
        if (!updated) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
        // A suspended or retired object must not stay reachable through a link that needs no login.
        if (lifecycle.to !== "PUBLISHED") {
          await ctx.store.revokeSmartLink(existing.object_id, principal.pseudonym).catch(() => undefined);
        }
        await audit({
          actorPseudonym: principal.pseudonym, actorRole: principal.role,
          actionType: lifecycle.action, targetType: "learning_object", targetId: existing.object_id,
          priorState: { status: existing.status }, resultingState: { status: lifecycle.to },
          outcome: "ALLOWED", correlationId: correlation,
        });
        const response = { ...updated, correlation_id: correlation };
        await complete(200, response);
        return send(reply, 200, response);
      });
    });
  }

  /**
   * Removes an object that was never delivered.
   *
   * The check is not a courtesy. An attempt names an object version and a package version, an xAPI
   * statement names the attempt, and a class result is produced by reading those back — so deleting
   * an object that has been launched turns a learner's record into a dangling reference. Retirement
   * exists for that case and is what the refusal points at.
   */
  app.delete("/api/v1/publisher/learning-objects/:objectId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.delete", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);

    return idempotently(reply, correlation, `publisher-delete:${objectId}`, idempotencyKey, null, async (complete) => {
      const existing = await openObject(req, reply, principal, correlation, "learning_object.delete", "repository_owner");
      if (!existing) return;

      const [attempts, assignments] = await Promise.all([
        ctx.store.listAttempts({ object_id: existing.object_id, limit: 1 }),
        ctx.store.assignmentsForObject(existing.object_id),
      ]);
      if (attempts.length > 0 || assignments.length > 0) {
        await audit({
          actorPseudonym: principal.pseudonym, actorRole: principal.role,
          actionType: "learning_object.delete", targetType: "learning_object", targetId: existing.object_id,
          outcome: "DENIED", reason: "LEARNING_OBJECT_IN_USE", correlationId: correlation,
        });
        return sendAdminError(reply, "LEARNING_OBJECT_IN_USE", correlation);
      }

      await ctx.store.revokeSmartLink(existing.object_id, principal.pseudonym).catch(() => undefined);
      const deleted = await ctx.catalogue.deleteObject(existing.object_id);
      if (!deleted) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.delete", targetType: "learning_object", targetId: existing.object_id,
        priorState: { status: existing.status, title: existing.title, repository_id: existing.repository_id },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { object_id: existing.object_id, deleted: true, correlation_id: correlation };
      await complete(200, response);
      return send(reply, 200, response);
    });
  });
}
