// Separation of duties: an action that needs approval is requested by one administrator and
// approved by another, and the database refuses a self-approval outright.
import { randomUUID } from "node:crypto";
import { AdminAuthError } from "./admin-authz.js";
import type { QueryableClient } from "./audit-writer.js";

export interface ApprovalRow {
  approval_request_id: string;
  action_type: string;
  target_type: string;
  target_id: string;
  requested_by_pseudonym: string;
  approver_pseudonym: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "CANCELLED";
  detail: unknown;
}

export async function createApprovalRequest(
  client: QueryableClient,
  input: { actionType: string; targetType: string; targetId: string; requestedByPseudonym: string; correlationId: string; detail?: unknown },
): Promise<string> {
  const approvalRequestId = randomUUID();
  await client.query(
    `insert into approval_request (approval_request_id,action_type,target_type,target_id,requested_by_pseudonym,status,correlation_id,detail)
     values ($1,$2,$3,$4,$5,'PENDING',$6,$7)`,
    [approvalRequestId, input.actionType, input.targetType, input.targetId, input.requestedByPseudonym, input.correlationId, input.detail ? JSON.stringify(input.detail) : null],
  );
  return approvalRequestId;
}

async function loadApprovalForUpdate(client: QueryableClient, approvalRequestId: string): Promise<ApprovalRow> {
  const result = (await client.query("select * from approval_request where approval_request_id=$1 for update", [approvalRequestId])) as { rows: ApprovalRow[] };
  const row = result.rows[0];
  if (!row) throw new AdminAuthError("APPROVAL_NOT_FOUND");
  return row;
}

export async function approveRequest(client: QueryableClient, approvalRequestId: string, approverPseudonym: string): Promise<ApprovalRow> {
  const row = await loadApprovalForUpdate(client, approvalRequestId);
  if (row.status !== "PENDING") throw new AdminAuthError("APPROVAL_NOT_FOUND");
  if (row.requested_by_pseudonym === approverPseudonym) throw new AdminAuthError("SEPARATION_OF_DUTIES_REQUIRED");
  await client.query("update approval_request set approver_pseudonym=$2, approved_at=now(), status='APPROVED' where approval_request_id=$1", [approvalRequestId, approverPseudonym]);
  return { ...row, approver_pseudonym: approverPseudonym, status: "APPROVED" };
}

export async function rejectRequest(client: QueryableClient, approvalRequestId: string, approverPseudonym: string, reason: string | undefined): Promise<ApprovalRow> {
  const row = await loadApprovalForUpdate(client, approvalRequestId);
  if (row.status !== "PENDING") throw new AdminAuthError("APPROVAL_NOT_FOUND");
  if (row.requested_by_pseudonym === approverPseudonym) throw new AdminAuthError("SEPARATION_OF_DUTIES_REQUIRED");
  await client.query("update approval_request set approver_pseudonym=$2, status='REJECTED', rejection_reason=$3 where approval_request_id=$1", [approvalRequestId, approverPseudonym, reason ?? null]);
  return { ...row, approver_pseudonym: approverPseudonym, status: "REJECTED" };
}

export async function executeRequest(client: QueryableClient, approvalRequestId: string): Promise<ApprovalRow> {
  const row = await loadApprovalForUpdate(client, approvalRequestId);
  if (row.status !== "APPROVED") throw new AdminAuthError("APPROVAL_REQUIRED");
  await client.query("update approval_request set status='EXECUTED' where approval_request_id=$1", [approvalRequestId]);
  return { ...row, status: "EXECUTED" };
}
