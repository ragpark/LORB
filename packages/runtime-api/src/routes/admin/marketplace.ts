// Marketplace: cross-repository discovery of published, opted-in objects, and each administrator's
// own bookmark of the ones they've chosen to make assignable to their classes.
//
// Nothing here copies content. An object still belongs to exactly one repository and stays owned and
// versioned by whoever authored it — bookmarking ("importing") it only records that this
// administrator has chosen to treat it as part of their own assignable set. Assignment
// (admin/classes.ts) already resolves an object_id independent of the caller's own repository, so
// the bookmark alone is enough to make an imported object show up as assignable; nothing about the
// assignment path itself changes.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type AdminRouteContext,
  correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError, withAdminTransaction, writeAudit,
} from "./shared.js";
import { adminDbPool } from "../../db/pool.js";
import { catalogue as defaultCatalogue, type CatalogueStore } from "../../catalogue/index.js";

const importSchema = z.object({ object_id: z.string().uuid() }).strict();

export function registerAdminMarketplaceRoutes(app: FastifyInstance, ctx: AdminRouteContext, deps: { catalogue?: CatalogueStore } = {}) {
  const catalogue = deps.catalogue ?? defaultCatalogue();

  /** Every published object any repository has opted in to listing, across the whole platform. */
  app.get("/api/v1/admin/marketplace", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "marketplace.list", "learning_object");
    if (!principal) return;
    const [objects, repositories] = await Promise.all([
      catalogue.learningObjects({ status: "PUBLISHED", marketplace_listed: true }),
      catalogue.repositories(),
    ]);
    const repositoryName = new Map(repositories.map((repository) => [repository.repository_id, repository.display_name]));
    const items = objects.map((object) => ({ ...object, publisher_name: repositoryName.get(object.repository_id) ?? "Unknown publisher" }));
    return { items, next_cursor: null, correlation_id: correlationOf(req) };
  });

  /** The calling administrator's own bookmarked objects — what "assignable from Assign work" merges
   *  in alongside whatever the caller's own repositories already hold. */
  app.get("/api/v1/admin/marketplace/imports", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "marketplace.imports.list", "learning_object");
    if (!principal) return;
    const rows = (await adminDbPool().query(
      "select object_id, imported_at from marketplace_import where imported_by_pseudonym = $1 order by imported_at desc",
      [principal.pseudonym],
    )).rows as Array<{ object_id: string; imported_at: Date | string }>;
    const objects = await Promise.all(rows.map((row) => catalogue.learningObject(row.object_id)));
    const items = rows
      .map((row, index) => ({ importedAt: row.imported_at, object: objects[index] }))
      // A bookmark can outlive the object it points at — a hard delete of a suspended/retired object
      // leaves nothing to resolve here. Never surface a bookmark with no object behind it.
      .filter((entry): entry is { importedAt: Date | string; object: NonNullable<typeof entry.object> } => entry.object !== undefined)
      .map((entry) => ({
        ...entry.object,
        imported_at: entry.importedAt instanceof Date ? entry.importedAt.toISOString() : entry.importedAt,
      }));
    return { items, next_cursor: null, correlation_id: correlationOf(req) };
  });

  /** Bookmarks a listed object into the caller's own assignable set. */
  app.post("/api/v1/admin/marketplace/imports", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "marketplace.import", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    if (!requireIdempotencyKey(req, reply)) return;
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);

    const object = await catalogue.learningObject(parsed.data.object_id);
    // Reported the same way whether the object doesn't exist or was simply never listed: an
    // administrator outside the owning repository must not learn that an unlisted object exists.
    if (!object || object.status !== "PUBLISHED" || !object.marketplace_listed) {
      return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    }

    await withAdminTransaction(async (client) => {
      await client.query(
        "insert into marketplace_import (imported_by_pseudonym, object_id) values ($1,$2) on conflict (imported_by_pseudonym, object_id) do nothing",
        [principal.pseudonym, object.object_id],
      );
      await writeAudit(client, {
        actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "marketplace.import",
        targetType: "learning_object", targetId: object.object_id,
        resultingState: { repository_id: object.repository_id }, outcome: "ALLOWED", correlationId: correlation,
      });
    });
    return reply.code(201).send({ object_id: object.object_id, correlation_id: correlation });
  });

  /** Removes a bookmark. The object itself, and every class it has already been assigned to, are untouched. */
  app.delete<{ Params: { objectId: string } }>("/api/v1/admin/marketplace/imports/:objectId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "marketplace.import_remove", "learning_object");
    if (!principal) return;
    const correlation = correlationOf(req);
    const removed = await withAdminTransaction(async (client) => {
      const result = await client.query(
        "delete from marketplace_import where imported_by_pseudonym = $1 and object_id = $2",
        [principal.pseudonym, req.params.objectId],
      );
      await writeAudit(client, {
        actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "marketplace.import_remove",
        targetType: "learning_object", targetId: req.params.objectId,
        resultingState: { removed: result.rowCount ?? 0 }, outcome: "ALLOWED", correlationId: correlation,
      });
      return result.rowCount ?? 0;
    });
    if (!removed) return sendAdminError(reply, "LEARNING_OBJECT_NOT_FOUND", correlation);
    return reply.code(204).send();
  });
}
