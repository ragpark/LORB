// Administration: repositories and their lifecycle.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type AdminRouteContext,
  correlationOf,
  requireAdmin,
  requireAuthorised,
  requireIdempotencyKey,
  sendAdminError,
  withAdminTransaction,
  writeAudit,
  AdminAuthError,
} from "./shared.js";
import { approvalRequiredFor, requireRepositoryMembership } from "../../services/admin-authz.js";
import { createApprovalRequest } from "../../services/approval-service.js";
import { adminDbPool } from "../../db/pool.js";

const createRepositorySchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{3,32}$/), display_name: z.string().min(3).max(120) }).strict();

export function registerAdminRepositoryRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get("/api/v1/admin/repositories", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "repository.list", "repository");
    if (!principal) return;
    const correlation = correlationOf(req);
    const rows = principal.platformAdmin
      ? (await adminDbPool().query("select * from repository order by created_at desc")).rows
      : (
          await adminDbPool().query(
            `select r.* from repository r
             join repository_membership m on m.repository_id = r.repository_id and m.revoked_at is null
             where m.principal_subject_pseudonym = $1
             group by r.repository_id order by r.created_at desc`,
            [principal.pseudonym],
          )
        ).rows;
    return { items: rows, next_cursor: null, correlation_id: correlation };
  });

  app.get<{ Params: { repositoryId: string } }>("/api/v1/admin/repositories/:repositoryId", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "repository.get", "repository");
    if (!principal) return;
    const correlation = correlationOf(req);
    const ok = await requireAuthorised(req, reply, principal, "repository.get", "repository", req.params.repositoryId, () =>
      requireRepositoryMembership(adminDbPool(), req.params.repositoryId, principal, "repository_reader"),
    );
    if (!ok) return;
    const result = await adminDbPool().query("select * from repository where repository_id = $1", [req.params.repositoryId]);
    if (!result.rows[0]) return sendAdminError(reply, "REPOSITORY_NOT_FOUND", correlation);
    return result.rows[0];
  });

  app.post("/api/v1/admin/repositories", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "repository.create", "repository");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const parsed = createRepositorySchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "REPOSITORY_SLUG_INVALID", correlation);
    try {
      const repositoryId = await withAdminTransaction(async (client) => {
        const existing = await client.query("select 1 from repository where slug = $1", [parsed.data.slug]);
        if (existing.rowCount) throw new AdminAuthError("REPOSITORY_SLUG_TAKEN");
        const repositoryId = randomUUID();
        await client.query("insert into repository (repository_id, slug, display_name, status) values ($1,$2,$3,'ACTIVE')", [repositoryId, parsed.data.slug, parsed.data.display_name]);
        await client.query(
          "insert into repository_membership (membership_id, repository_id, principal_subject_pseudonym, principal_role, granted_by_pseudonym, correlation_id) values ($1,$2,$3,'repository_owner',$3,$4)",
          [randomUUID(), repositoryId, principal.pseudonym, correlation],
        );
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "repository.create", targetType: "repository", targetId: repositoryId, resultingState: { slug: parsed.data.slug, display_name: parsed.data.display_name, status: "ACTIVE" }, outcome: "ALLOWED", correlationId: correlation });
        return repositoryId;
      });
      return reply.code(201).send({ repository_id: repositoryId, slug: parsed.data.slug, display_name: parsed.data.display_name, status: "ACTIVE", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  async function requestLifecycleTransition(actionType: "repository.suspend" | "repository.retire", req: any, reply: any) {
    const principal = await requireAdmin(req, reply, ctx, actionType, "repository");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const repositoryId = req.params.repositoryId as string;
    const ok = await requireAuthorised(req, reply, principal, actionType, "repository", repositoryId, () =>
      requireRepositoryMembership(adminDbPool(), repositoryId, principal, "repository_owner"),
    );
    if (!ok) return;
    try {
      const approvalRequestId = await withAdminTransaction(async (client) => {
        const repo = await client.query("select status from repository where repository_id = $1", [repositoryId]);
        if (!repo.rows[0]) throw new AdminAuthError("REPOSITORY_NOT_FOUND");
        if (repo.rows[0].status !== "ACTIVE") throw new AdminAuthError("REPOSITORY_STATE_INVALID");
        if (!approvalRequiredFor(actionType)) throw new AdminAuthError("ADMIN_REQUEST_INVALID");
        const id = await createApprovalRequest(client, { actionType, targetType: "repository", targetId: repositoryId, requestedByPseudonym: principal.pseudonym, correlationId: correlation });
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType, targetType: "repository", targetId: repositoryId, outcome: "ALLOWED", reason: "APPROVAL_REQUESTED", approvalRequestId: id, correlationId: correlation });
        return id;
      });
      return reply.code(202).send({ approval_request_id: approvalRequestId, status: "PENDING", correlation_id: correlation });
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  }

  app.post<{ Params: { repositoryId: string } }>("/api/v1/admin/repositories/:repositoryId/suspend", (req, reply) => requestLifecycleTransition("repository.suspend", req, reply));
  app.post<{ Params: { repositoryId: string } }>("/api/v1/admin/repositories/:repositoryId/retire", (req, reply) => requestLifecycleTransition("repository.retire", req, reply));
}
