// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1 approval inbox and execution.
// Not enumerated as its own file in the original brief's Section 3 layout (which lists repositories/memberships/players/launch-policies/audit
// under routes/admin/), but Section 8.7's approval-request endpoints need a home; grouping them with audit.ts would have been worse for
// maintainability, so they live in their own file instead.
import type { FastifyInstance } from "fastify";
import { type AdminRouteContext, correlationOf, requireAdmin, requireIdempotencyKey, sendAdminError, withAdminTransaction, writeAudit, AdminAuthError, type QueryableClient } from "./shared.js";
import { approveRequest, executeRequest, rejectRequest, type ApprovalRow } from "../../services/approval-service.js";
import { adminDbPool } from "../../db/pool.js";

async function applyApprovedTransition(client: QueryableClient, approval: ApprovalRow, executorPseudonym: string): Promise<Record<string, unknown>> {
  const detail = (approval.detail ?? {}) as Record<string, unknown>;
  switch (approval.action_type) {
    case "repository.suspend":
      await client.query("update repository set status='SUSPENDED', suspended_at=now() where repository_id=$1", [approval.target_id]);
      return { status: "SUSPENDED" };
    case "repository.retire":
      await client.query("update repository set status='RETIRING', retiring_at=now() where repository_id=$1", [approval.target_id]);
      return { status: "RETIRING" };
    case "player_version.approve":
      await client.query("update player_version set status='APPROVED', approved_at=now(), approved_by_pseudonym=$2 where player_version_id=$1", [approval.target_id, executorPseudonym]);
      return { status: "APPROVED" };
    case "player_version.activate":
      await client.query("update player_version set status='ACTIVE', activated_at=now(), activated_by_pseudonym=$2 where player_version_id=$1", [approval.target_id, executorPseudonym]);
      if (detail.player_id) await client.query("update player set active_player_version_id=$1, updated_at=now() where player_id=$2", [approval.target_id, detail.player_id]);
      return { status: "ACTIVE" };
    case "player_version.suspend":
      await client.query("update player_version set status='SUSPENDED', suspended_at=now(), suspended_by_pseudonym=$2 where player_version_id=$1", [approval.target_id, executorPseudonym]);
      return { status: "SUSPENDED" };
    case "launch_policy_version.publish":
      await client.query("update launch_policy_version set status='PUBLISHED', published_at=now(), published_by_pseudonym=$2 where launch_policy_version_id=$1", [approval.target_id, executorPseudonym]);
      if (detail.launch_policy_id) await client.query("update launch_policy set active_launch_policy_version_id=$1, updated_at=now() where launch_policy_id=$2", [approval.target_id, detail.launch_policy_id]);
      return { status: "PUBLISHED" };
    case "launch_policy_version.activate":
      if (detail.launch_policy_id) await client.query("update launch_policy set status='ACTIVE', active_launch_policy_version_id=$1, updated_at=now() where launch_policy_id=$2", [approval.target_id, detail.launch_policy_id]);
      return { status: "ACTIVE" };
    default:
      throw new AdminAuthError("ADMIN_REQUEST_INVALID");
  }
}

export function registerAdminApprovalRoutes(app: FastifyInstance, ctx: AdminRouteContext) {
  app.get("/api/v1/admin/approval-requests", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "approval.list", "approval_request");
    if (!principal) return;
    const status = (req.query as { status?: string }).status ?? "PENDING";
    const rows = await adminDbPool().query("select * from approval_request where status = $1 order by requested_at desc", [status]);
    return { items: rows.rows, next_cursor: null, correlation_id: correlationOf(req) };
  });

  app.post<{ Params: { approvalRequestId: string } }>("/api/v1/admin/approval-requests/:approvalRequestId/approve", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "approval.approve", "approval_request");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    try {
      await withAdminTransaction(async (client) => {
        const approval = await approveRequest(client, req.params.approvalRequestId, principal.pseudonym);
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "approval.approve", targetType: "approval_request", targetId: approval.approval_request_id, outcome: "ALLOWED", correlationId: correlation });
      });
      return { approval_request_id: req.params.approvalRequestId, status: "APPROVED", correlation_id: correlation };
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  app.post<{ Params: { approvalRequestId: string } }>("/api/v1/admin/approval-requests/:approvalRequestId/reject", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "approval.reject", "approval_request");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    const reason = (req.body as { reason?: string } | undefined)?.reason;
    try {
      await withAdminTransaction(async (client) => {
        const approval = await rejectRequest(client, req.params.approvalRequestId, principal.pseudonym, reason);
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "approval.reject", targetType: "approval_request", targetId: approval.approval_request_id, reason, outcome: "ALLOWED", correlationId: correlation });
      });
      return { approval_request_id: req.params.approvalRequestId, status: "REJECTED", correlation_id: correlation };
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });

  app.post<{ Params: { approvalRequestId: string } }>("/api/v1/admin/approval-requests/:approvalRequestId/execute", async (req, reply) => {
    const principal = await requireAdmin(req, reply, ctx, "approval.execute", "approval_request");
    if (!principal) return;
    const correlation = correlationOf(req);
    const idempotencyKey = requireIdempotencyKey(req, reply);
    if (!idempotencyKey) return;
    try {
      const resultingState = await withAdminTransaction(async (client) => {
        const approval = await executeRequest(client, req.params.approvalRequestId);
        const resultingState = await applyApprovedTransition(client, approval, principal.pseudonym);
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: "approval.execute", targetType: "approval_request", targetId: approval.approval_request_id, outcome: "ALLOWED", correlationId: correlation });
        await writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType: approval.action_type, targetType: approval.target_type, targetId: approval.target_id, resultingState, outcome: "ALLOWED", approvalRequestId: approval.approval_request_id, correlationId: correlation });
        return resultingState;
      });
      return { approval_request_id: req.params.approvalRequestId, status: "EXECUTED", resulting_state: resultingState, correlation_id: correlation };
    } catch (error) {
      if (error instanceof AdminAuthError) return sendAdminError(reply, error.code, correlation);
      throw error;
    }
  });
}
