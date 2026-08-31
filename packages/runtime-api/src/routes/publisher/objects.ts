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
import {
  audioDraftSchema, documentDraftSchema, launchContextSchema, ltiToolDraftSchema, quizDraftSchema, videoDraftSchema,
} from "../../../../contracts/src/index.js";
import type { CatalogueStore, LearningObjectRow, MediaKind } from "../../catalogue/index.js";
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

/**
 * What subscribing costs, set by the listing repository — informational only, never enforced or
 * charged here. `listed: true` with every pricing field omitted (or null) lists the object as free;
 * a non-zero price requires both a currency and a billing period, so a subscriber is never shown a
 * bare number with nothing to say what it's a number of.
 */
const marketplaceListingSchema = z.object({
  listed: z.boolean(),
  price_cents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code").nullable().optional(),
  billing_period: z.enum(["one_time", "month", "year"]).nullable().optional(),
}).strict()
  .refine((v) => !((v.price_cents ?? 0) > 0 && !v.currency), "currency is required when price_cents is set")
  .refine((v) => !((v.price_cents ?? 0) > 0 && !v.billing_period), "billing_period is required when price_cents is set");

/** repository_id plus whatever the specific draft schema (quiz, video, document, audio) validates next. */
const authoringEnvelopeSchema = z.object({ repository_id: z.string().uuid().optional() })
  .catchall(z.unknown());

const documentUploadSchema = z.object({
  repository_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  source_format: z.enum(["pptx", "ppt", "docx", "doc"]),
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  keep_pdf: z.boolean().optional(),
}).strict();

/**
 * Setting a launch context, or clearing it with null. The context itself is validated by the shared
 * contract: a theme is a token the module resolves against assets it already ships — never a URL,
 * because the module runs sandboxed under a CSP that a stylesheet address would either violate or
 * widen — and settings are small named scalars, not a place for secrets.
 */
const launchContextBodySchema = z.object({ launch_context: launchContextSchema.nullable() }).strict();

export interface PublisherContext {
  catalogue: CatalogueStore;
  /** Idempotency records live here; the publisher shares the runtime's, scoped per surface. */
  store: RuntimeStore;
  adminCtx: AdminRouteContext;
  /**
   * Base origin of the document-converter service (packages/document-converter), used only by
   * `.../learning-objects/documents/upload`. Absent in a deployment that hasn't stood that service
   * up — the upload route refuses cleanly rather than the whole publisher surface failing to start.
   */
  documentConverterUrl?: string;
  /**
   * False only in production with no persistent LTI signing key configured. Outside production an
   * ephemeral key generated at start-up is fine — nothing depends on it surviving a restart or
   * matching across replicas. In production it would: a login-hint minted by one replica would be
   * rejected by another, and a tool could fetch JWKS from a replica whose key never signed the
   * id_token it received. Registration refuses cleanly rather than an LTI launch failing at random
   * depending on which replica happens to serve it.
   */
  ltiKeysConfigured: boolean;
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

  /**
   * Whether anything points at this object.
   *
   * Three tables, because there are three ways an object gets used and they were built by different
   * surfaces: `attempt` for anything ever launched, `assignment` for an agent or internal batch, and
   * `class_assignment` for a teacher assigning work to a class. The last lives in the administration
   * database rather than the runtime store, and reading only the first two would have let an object
   * a class is working through be deleted out from under its roster.
   */
  const inUse = async (objectId: string): Promise<boolean> => {
    const [attempts, assignments] = await Promise.all([
      ctx.store.listAttempts({ object_id: objectId, limit: 1 }),
      ctx.store.assignmentsForObject(objectId),
    ]);
    if (attempts.length > 0 || assignments.length > 0) return true;
    if (ctx.catalogue.kind !== "postgres") return false;
    const classes = await adminDbPool().query("select 1 from class_assignment where object_id = $1 limit 1", [objectId]);
    return (classes.rowCount ?? 0) > 0;
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
      const envelope = authoringEnvelopeSchema.safeParse(body);
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

  /**
   * Registering an LTI 1.3 tool: a third party's own content, launched by a real OIDC/id_token
   * handshake (`/api/v1/lti/authorize`) rather than embedding an arbitrary origin directly. This is
   * the only learning-object kind that ever points at an external URL — every other kind's
   * `module_path` stays a relative path under the Player Shell's own origin, per the invariant this
   * file documents at the top. Registration mints `client_id`/`deployment_id` server-side; there is
   * no separate platform/tool registry, each LTI object is a fully self-contained registration.
   */
  app.post("/api/v1/publisher/learning-objects/lti-tools", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.author_lti_tool", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!ctx.ltiKeysConfigured) return sendAdminError(reply, "LTI_SIGNING_KEY_NOT_CONFIGURED", correlation);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, "publisher-author-lti-tool", idempotencyKey, body, async (complete) => {
      const envelope = authoringEnvelopeSchema.safeParse(body);
      if (!envelope.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const { repository_id: requestedRepository, ...rest } = envelope.data;
      const draft = ltiToolDraftSchema.safeParse(rest);
      if (!draft.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

      const repository = requestedRepository
        ? await ctx.catalogue.repository(requestedRepository)
        : await ctx.catalogue.defaultRepository();
      if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
      if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);
      if (!await authorised(req, reply, principal, "learning_object.author_lti_tool", repository.repository_id, undefined, "repository_operator")) return;

      const registered = await ctx.catalogue.registerLtiTool(draft.data, {
        repository_id: repository.repository_id,
        authored_by: principal.pseudonym,
      });
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.author_lti_tool", targetType: "learning_object", targetId: registered.object_id,
        resultingState: { client_id: registered.client_id, deployment_id: registered.deployment_id },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...registered, repository_id: repository.repository_id, correlation_id: correlation };
      await complete(201, response);
      return send(reply, 201, response);
    });
  });

  /**
   * Registering a video, document, or audio object: structured JSON content bound to that kind's
   * fixed, already-reviewed shared player — the same authoring shape and trust model as the quiz
   * route above, and the person-reachable counterpart to the internal service surface the agent
   * connector uses (routes/internal/media.ts). No bundle is uploaded here either.
   *
   * A document's `pages` must already be image URLs — this route does not convert a PowerPoint or
   * Word file itself; `.../documents/upload` below does that first and then registers the result.
   */
  const MEDIA_DRAFT_SCHEMAS = { video: videoDraftSchema, document: documentDraftSchema, audio: audioDraftSchema } as const;
  const MEDIA_ROUTE_PATHS: Record<MediaKind, string> = {
    video: "/api/v1/publisher/learning-objects/videos",
    document: "/api/v1/publisher/learning-objects/documents",
    audio: "/api/v1/publisher/learning-objects/audio",
  };
  const registerMediaObject = async (
    kind: MediaKind, req: FastifyRequest, reply: FastifyReply, draftBody: unknown,
  ): Promise<void> => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, `learning_object.author_${kind}`, "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;

    await idempotently(reply, correlation, `publisher-author-${kind}`, idempotencyKey, draftBody, async (complete) => {
      const envelope = authoringEnvelopeSchema.safeParse(draftBody);
      if (!envelope.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const { repository_id: requestedRepository, ...rest } = envelope.data;
      const draft = MEDIA_DRAFT_SCHEMAS[kind].safeParse(rest);
      if (!draft.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

      const repository = requestedRepository
        ? await ctx.catalogue.repository(requestedRepository)
        : await ctx.catalogue.defaultRepository();
      if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
      if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);
      if (!await authorised(req, reply, principal, `learning_object.author_${kind}`, repository.repository_id, undefined, "repository_operator")) return;

      const registered = await ctx.catalogue.registerMedia(kind, draft.data, {
        repository_id: repository.repository_id,
        authored_by: principal.pseudonym,
      });
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: `learning_object.author_${kind}`, targetType: "learning_object", targetId: registered.object_id,
        resultingState: { content_version: registered.content_version },
        outcome: "ALLOWED", correlationId: correlation,
      });
      const response = { ...registered, repository_id: repository.repository_id, correlation_id: correlation };
      await complete(201, response);
      return send(reply, 201, response);
    });
  };
  for (const kind of Object.keys(MEDIA_DRAFT_SCHEMAS) as MediaKind[]) {
    app.post(MEDIA_ROUTE_PATHS[kind], async (req, reply) => {
      const body = (req as { body: unknown }).body;
      return registerMediaObject(kind, req, reply, body);
    });
  }

  /**
   * Uploads a PowerPoint or Word file, converts it to page images via the document-converter
   * service, and registers the result as a document object in one call — the path a person actually
   * wants, versus assembling `pages` by hand against `.../documents` above.
   */
  // The base64 envelope of an uploaded file is ~1.4x its raw bytes (same factor document-converter's
  // own MAX_UPLOAD_BYTES check uses); the Runtime API's global BODY_LIMIT_BYTES (128KB, sized for
  // ordinary JSON requests) would reject an ordinary PowerPoint or Word file well under a megabyte,
  // long before this handler ever ran. This route alone gets a limit sized for what it actually is.
  const DOCUMENT_UPLOAD_BODY_LIMIT_BYTES = Math.ceil(50 * 1024 * 1024 * 1.4);
  app.post("/api/v1/publisher/learning-objects/documents/upload", { bodyLimit: DOCUMENT_UPLOAD_BODY_LIMIT_BYTES }, async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.author_document", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, "publisher-upload-document", idempotencyKey, body, async (complete) => {
      const parsed = documentUploadSchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      if (!ctx.documentConverterUrl) return sendAdminError(reply, "DOCUMENT_CONVERTER_NOT_CONFIGURED", correlation);

      // Resolve and authorise before spending anything on conversion: an administrator who lacks
      // repository_operator membership, or names a repository that doesn't exist, must not be able
      // to make this route run LibreOffice/Poppler on their upload anyway — that's real CPU, memory
      // and disk on the converter, spent before the refusal they were always going to get.
      const { repository_id: requestedRepository, ...upload } = parsed.data;
      const repository = requestedRepository
        ? await ctx.catalogue.repository(requestedRepository)
        : await ctx.catalogue.defaultRepository();
      if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
      if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);
      if (!await authorised(req, reply, principal, "learning_object.author_document", repository.repository_id, undefined, "repository_operator")) return;

      let draft: unknown;
      try {
        const converted = await fetch(`${ctx.documentConverterUrl.replace(/\/$/, "")}/convert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(upload),
        });
        if (!converted.ok) return sendAdminError(reply, "DOCUMENT_CONVERSION_FAILED", correlation);
        draft = (await converted.json() as { draft: unknown }).draft;
      } catch {
        return sendAdminError(reply, "DOCUMENT_CONVERSION_FAILED", correlation);
      }
      const parsedDraft = documentDraftSchema.safeParse(draft);
      if (!parsedDraft.success) return sendAdminError(reply, "DOCUMENT_CONVERSION_FAILED", correlation);

      const registered = await ctx.catalogue.registerMedia("document", parsedDraft.data, {
        repository_id: repository.repository_id,
        authored_by: principal.pseudonym,
      });
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.author_document", targetType: "learning_object", targetId: registered.object_id,
        resultingState: { content_version: registered.content_version },
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
   * Toggles whether this object is discoverable on the cross-repository marketplace
   * (GET /api/v1/admin/marketplace). Listing changes nothing about the object itself — not its
   * version chain, not its content, not which repository owns it — only whether an administrator
   * outside this repository can find and bookmark it.
   */
  app.put("/api/v1/publisher/learning-objects/:objectId/marketplace-listing", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.marketplace_listing", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, `publisher-marketplace-listing:${objectId}`, idempotencyKey, body, async (complete) => {
      const parsed = marketplaceListingSchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const existing = await openObject(req, reply, principal, correlation, "learning_object.marketplace_listing", "repository_operator");
      if (!existing) return;
      if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlation);

      // Every call is authoritative for price, not a partial patch: a caller who wants to keep the
      // current price re-sends it. Omitting the fields here means free, not "leave unchanged" — that
      // reading belongs to internal callers of the catalogue method, not to this admin-facing route.
      const pricing = {
        price_cents: parsed.data.price_cents ?? null,
        currency: parsed.data.currency ?? null,
        billing_period: parsed.data.billing_period ?? null,
      };
      const updated = await ctx.catalogue.setMarketplaceListed(existing.object_id, parsed.data.listed, pricing);
      if (!updated) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.marketplace_listing", targetType: "learning_object", targetId: updated.object_id,
        priorState: {
          marketplace_listed: existing.marketplace_listed ?? false,
          marketplace_price_cents: existing.marketplace_price_cents ?? null,
        },
        resultingState: { marketplace_listed: parsed.data.listed, ...pricing },
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

  /**
   * Sets or clears the object's launch context: publisher-authored configuration the object carries
   * into its own launch (a theme token, small named settings), invisible to the learner. It reaches
   * a descriptor-pinned surface, so it follows the publishing rule rather than the metadata rule —
   * every change is a new object version, and an attempt launched before the change keeps the
   * context it was issued with.
   */
  app.put("/api/v1/publisher/learning-objects/:objectId/launch-context", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.launch_context", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const objectId = objectIdOf(req);
    const body = (req as { body: unknown }).body;

    return idempotently(reply, correlation, `publisher-launch-context:${objectId}`, idempotencyKey, body, async (complete) => {
      const parsed = launchContextBodySchema.safeParse(body);
      if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
      const existing = await openObject(req, reply, principal, correlation, "learning_object.launch_context", "repository_operator");
      if (!existing) return;
      if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_STATE_INVALID", correlation);

      const revision = await ctx.catalogue.setLaunchContext(existing.object_id, parsed.data.launch_context);
      if (!revision) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      await audit({
        actorPseudonym: principal.pseudonym, actorRole: principal.role,
        actionType: "learning_object.launch_context", targetType: "learning_object", targetId: existing.object_id,
        priorState: { active_object_version_id: existing.active_object_version_id },
        resultingState: { active_object_version_id: revision.object_version_id, launch_context: revision.launch_context },
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
   * Removes an object that was withdrawn and never delivered.
   *
   * Two refusals, and neither is a courtesy. An attempt names an object version and a package
   * version, an xAPI statement names the attempt, and a class result is produced by reading those
   * back — so deleting an object that has been launched or assigned turns a learner's record into a
   * dangling reference. Retirement exists for that case and is what the refusal points at.
   *
   * And an object still in the catalogue is an object a launch can resolve *while this runs*, so
   * deletion is offered only once it has been suspended or retired. The check that decides both is
   * made again inside the deleting transaction, under a lock on the object row: the check below
   * produces the error a person reads, and the one in the transaction is the one that is true at the
   * moment the rows go.
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

      const refuse = async (code: string) => {
        await audit({
          actorPseudonym: principal.pseudonym, actorRole: principal.role,
          actionType: "learning_object.delete", targetType: "learning_object", targetId: existing.object_id,
          outcome: "DENIED", reason: code, correlationId: correlation,
        });
        return sendAdminError(reply, code, correlation);
      };

      if (existing.status !== "SUSPENDED" && existing.status !== "RETIRED") return refuse("LEARNING_OBJECT_DELIVERABLE");
      if (await inUse(existing.object_id)) return refuse("LEARNING_OBJECT_IN_USE");

      await ctx.store.revokeSmartLink(existing.object_id, principal.pseudonym).catch(() => undefined);
      const outcome = await ctx.catalogue.deleteObject(existing.object_id);
      if (outcome === "NOT_FOUND") return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
      if (outcome === "STATE_INVALID") return refuse("LEARNING_OBJECT_DELIVERABLE");
      // Something was launched or assigned between the check above and the transaction below. The
      // object is intact and the refusal is the same one the caller would have got a moment earlier.
      if (outcome === "IN_USE") return refuse("LEARNING_OBJECT_IN_USE");
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
