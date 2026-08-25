/**
 * The Publisher API.
 *
 * This is how content gets into a production catalogue. Until now the catalogue was three constants
 * compiled into the service, so "registering a learning object" meant editing and redeploying — the
 * single largest reason the platform could not be operated by anyone but its authors.
 *
 * Two rules are enforced here rather than left to the caller:
 *
 *   - A published package version is never modified in place. Publishing again creates a new
 *     immutable version and supersedes the previous one, so a descriptor that pinned the old version
 *     still describes what was actually delivered.
 *   - A module path is a path under the Player Shell origin, never an absolute URL. Accepting an
 *     arbitrary origin here would let a publisher point a launch at content nobody reviewed.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { CatalogueStore } from "../../catalogue/index.js";
import { correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError, type AdminRouteContext } from "../admin/shared.js";
import { withAdminTransaction, writeAudit } from "../admin/shared.js";

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

const registrationSchema = z.object({
  repository_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  duration: z.string().max(60).optional(),
  kind: z.string().regex(/^[a-z][a-z\d-]{1,60}$/).optional(),
  module_path: modulePath,
  semver,
  sha256,
}).strict();

const versionSchema = z.object({ semver, module_path: modulePath, sha256 }).strict();

export interface PublisherContext {
  catalogue: CatalogueStore;
  adminCtx: AdminRouteContext;
}

export function registerPublisherRoutes(app: FastifyInstance, ctx: PublisherContext): void {
  const send = (reply: unknown, status: number, body: unknown) =>
    (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send(body);

  app.get("/api/v1/publisher/learning-objects", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "publisher.list", "learning_object");
    if (!principal) return;
    const query = (req as { query: { repository_id?: string } }).query;
    return {
      items: await ctx.catalogue.learningObjects({ repository_id: query.repository_id }),
      next_cursor: null,
      correlation_id: correlationOf(req),
    };
  });

  app.post("/api/v1/publisher/learning-objects", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.register", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;

    const parsed = registrationSchema.safeParse((req as { body: unknown }).body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

    const repository = await ctx.catalogue.repository(parsed.data.repository_id);
    if (!repository) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
    if (repository.status !== "ACTIVE") return sendAdminError(reply, "REPOSITORY_STATE_INVALID", correlation);

    const object = await ctx.catalogue.registerObject({ ...parsed.data, authored_by: principal.pseudonym });
    await withAdminTransaction((client) => writeAudit(client, {
      actorPseudonym: principal.pseudonym, actorRole: principal.role,
      actionType: "learning_object.register", targetType: "learning_object", targetId: object.object_id,
      resultingState: { status: object.status, active_package_version_id: object.active_package_version_id },
      outcome: "ALLOWED", correlationId: correlation,
    })).catch(() => undefined);
    return send(reply, 201, { ...object, correlation_id: correlation });
  });

  app.post("/api/v1/publisher/learning-objects/:objectId/versions", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.publish_version", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;

    const parsed = versionSchema.safeParse((req as { body: unknown }).body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

    const objectId = (req as { params: { objectId: string } }).params.objectId;
    const existing = await ctx.catalogue.learningObject(objectId);
    if (!existing) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    if (existing.status === "RETIRED") return sendAdminError(reply, "LEARNING_OBJECT_NOT_PUBLISHED", correlation);

    const updated = await ctx.catalogue.publishObjectVersion(objectId, parsed.data);
    if (!updated) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    await withAdminTransaction((client) => writeAudit(client, {
      actorPseudonym: principal.pseudonym, actorRole: principal.role,
      actionType: "learning_object.publish_version", targetType: "learning_object", targetId: updated.object_id,
      priorState: { active_package_version_id: existing.active_package_version_id },
      resultingState: { active_package_version_id: updated.active_package_version_id },
      outcome: "ALLOWED", correlationId: correlation,
    })).catch(() => undefined);
    return send(reply, 201, { ...updated, correlation_id: correlation });
  });

  app.post("/api/v1/publisher/learning-objects/:objectId/retire", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx.adminCtx, "learning_object.retire", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;

    const objectId = (req as { params: { objectId: string } }).params.objectId;
    const existing = await ctx.catalogue.learningObject(objectId);
    if (!existing) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    const retired = await ctx.catalogue.retireObject(objectId);
    await withAdminTransaction((client) => writeAudit(client, {
      actorPseudonym: principal.pseudonym, actorRole: principal.role,
      actionType: "learning_object.retire", targetType: "learning_object", targetId: objectId,
      priorState: { status: existing.status }, resultingState: { status: "RETIRED" },
      outcome: "ALLOWED", correlationId: correlation,
    })).catch(() => undefined);
    return { ...retired, correlation_id: correlation };
  });
}
