// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type AdminRouteContext, correlationOf, requireAdmin, requireAuthorised, requireIdempotencyKey, sendAdminError, withAdminTransaction, writeAudit, AdminAuthError } from "./shared.js";
import { requireRepositoryMembership } from "../../services/admin-authz.js";
import { adminDbPool } from "../../db/pool.js";

const grantSchema = z.object({ principal_subject_pseudonym: z.string().min(1), principal_role: z.enum(["repository_owner", "repository_operator", "repository_reader"]) }).strict();

export function registerAdminMembershipRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get<{ Params: { repositoryId: string } }>("/api/v1/admin/repositories/:repositoryId/memberships", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "membership.list", "repository_membership");
    if (!principal) return;
    const correlation = correlationOf(req);
    const ok = await requireAuthorised(req, reply, principal, "membership.list", "repository_membership", req.params.repositoryId, () =>
      requireRepositoryMembership(adminDbPool(), req.params.repositoryId, principal, "repository_reader"),
    );
    if (!ok) return;
    const rows = await adminDbPool().query(
      "select membership_id, repository_id, principal_subject_pseudonym, principal_role, granted_by_pseudonym, granted_at from repository_membership where repository_id = $1 and revoked_at is null order by granted_at desc",
      [req.params.repositoryId],
    );
    return { items: rows.rows, next_cursor: null, correlation_id: correlation };
  });

  app.post<{ Params: { repositoryId: string } }>("/api/v1/admin/repositories/:repositoryId/memberships", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "membership.grant", "repository_membership");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const ok = await requireAuthorised(req, reply, principal, "membership.grant", "repository_membership", req.params.repositoryId, () =>
      requireRepositoryMembership(adminDbPool(), req.params.repositoryId, principal, "repository_owner"),
    );
    if (!ok) return;
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return sendAdminError(reply, "ADMIN_REQUEST_INVALID", correlation);
    const membershipId = randomUUID();
    await withAdminTransaction(async (client) => {
      await client.query(
        "insert into repository_membership (membership_id, repository_id, principal_subject_pseudonym, principal_role, granted_by_pseudonym, correlation_id) values ($1,$2,$3,$4,$5,$6)",
        [membershipId, req.params.repositoryId, parsed.data.principal_subject_pseudonym, parsed.data.principal_role, principal.pseudonym, correlation],
      );
      await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "membership.grant", targetType: "repository_membership", targetId: membershipId, resultingState: parsed.data, outcome: "ALLOWED", correlationId: correlation });
    });
    return reply.code(201).send({ membership_id: membershipId, correlation_id: correlation });
  });

  app.post<{ Params: { repositoryId: string; membershipId: string } }>("/api/v1/admin/repositories/:repositoryId/memberships/:membershipId/revoke", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "membership.revoke", "repository_membership");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const ok = await requireAuthorised(req, reply, principal, "membership.revoke", "repository_membership", req.params.repositoryId, () =>
      requireRepositoryMembership(adminDbPool(), req.params.repositoryId, principal, "repository_owner"),
    );
    if (!ok) return;
    try {
      await withAdminTransaction(async (client) => {
        const result = await client.query(
          "update repository_membership set revoked_at = now(), revoked_by_pseudonym = $3 where membership_id = $1 and repository_id = $2 and revoked_at is null returning membership_id",
          [req.params.membershipId, req.params.repositoryId, principal.pseudonym],
        );
        if (!result.rowCount) throw new AdminAuthError("ADMIN_REQUEST_INVALID");
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "membership.revoke", targetType: "repository_membership", targetId: req.params.membershipId, outcome: "ALLOWED", correlationId: correlation });
      });
      return { membership_id: req.params.membershipId, revoked: true, correlation_id: correlation };
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });
}
