// The audit trail. Every administrative decision is recorded, allowed or denied, with the actor as
// a pseudonym and the state redacted of anything that must never be written down.
import { randomUUID } from "node:crypto";

export interface AuditInput {
  actorPseudonym: string;
  actorRole: string;
  actionType: string;
  targetType: string;
  targetId?: string;
  priorState?: unknown;
  resultingState?: unknown;
  outcome: "ALLOWED" | "DENIED" | "FAILED";
  reason?: string;
  approvalRequestId?: string;
  correlationId: string;
}

export interface QueryableClient {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}

/** Redact anything that must never reach the audit trail: subjects, secrets, tokens, descriptors. */
const forbiddenAuditKey = /(^|_)(subject|tenant_secret|private_key|token|signed_descriptor|bearer)($|_)/i;
function redactAuditState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditState);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
        forbiddenAuditKey.test(key) ? [] : [[key, redactAuditState(item)]],
      ),
    );
  }
  return value;
}

export async function writeAudit(client: QueryableClient, input: AuditInput): Promise<string> {
  const auditId = randomUUID();
  await client.query(
    `insert into audit_record (audit_id,actor_pseudonym,actor_role,action_type,target_type,target_id,prior_state,resulting_state,outcome,reason,approval_request_id,correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      auditId,
      input.actorPseudonym,
      input.actorRole,
      input.actionType,
      input.targetType,
      input.targetId ?? null,
      input.priorState !== undefined ? JSON.stringify(redactAuditState(input.priorState)) : null,
      input.resultingState !== undefined ? JSON.stringify(redactAuditState(input.resultingState)) : null,
      input.outcome,
      input.reason ?? null,
      input.approvalRequestId ?? null,
      input.correlationId,
    ],
  );
  return auditId;
}
