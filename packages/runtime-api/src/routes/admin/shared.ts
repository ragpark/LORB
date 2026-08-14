// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1 route helpers.
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminAuthError, authenticateAdmin, type AdminPrincipal } from "../../services/admin-authz.js";
import { writeAudit, type QueryableClient } from "../../services/audit-writer.js";
import { withAdminTransaction } from "../../db/pool.js";

export interface AdminRouteContext {
  iesKey: unknown;
  iesIssuer: string;
  tenantSecret: Buffer;
  playerModuleOriginAllowlist: string[];
}

const ADMIN_ERROR_STATUS: Record<string, number> = {
  AUTHENTICATION_EXPIRED: 401,
  SESSION_EXPIRED: 401,
  ADMIN_AUDIT_DENIED: 403,
  MEMBERSHIP_NOT_PERMITTED: 403,
  SEPARATION_OF_DUTIES_REQUIRED: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_NOT_FOUND: 404,
  REPOSITORY_SLUG_INVALID: 400,
  REPOSITORY_SLUG_TAKEN: 409,
  REPOSITORY_NOT_FOUND: 404,
  REPOSITORY_STATE_INVALID: 409,
  PLAYER_NOT_FOUND: 404,
  PLAYER_VERSION_IMMUTABLE: 409,
  PLAYER_ORIGIN_NOT_ALLOWED: 403,
  PLAYER_INTEGRITY_WEAK: 400,
  LAUNCH_POLICY_NOT_FOUND: 404,
  LAUNCH_POLICY_VERSION_IMMUTABLE: 409,
  LAUNCH_POLICY_RULES_INVALID: 400,
  ADMIN_REQUEST_INVALID: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
};

const ADMIN_ERROR_TITLE: Record<string, string> = {
  AUTHENTICATION_EXPIRED: "Your session has expired",
  ADMIN_AUDIT_DENIED: "Administrator access is required",
  MEMBERSHIP_NOT_PERMITTED: "You do not have the required repository membership",
  SEPARATION_OF_DUTIES_REQUIRED: "A different administrator must approve this request",
  APPROVAL_REQUIRED: "This action requires an approved request first",
  APPROVAL_NOT_FOUND: "Approval request not found",
  PLAYER_VERSION_IMMUTABLE: "This player version is immutable",
  LAUNCH_POLICY_VERSION_IMMUTABLE: "This launch policy version is immutable",
};

export function adminProblem(code: string, correlation_id: string, status = ADMIN_ERROR_STATUS[code] ?? 400) {
  return {
    type: `https://lorb.example/errors/${code}`,
    title: ADMIN_ERROR_TITLE[code] ?? "We could not complete that request",
    status,
    code,
    detail: ADMIN_ERROR_TITLE[code] ?? "Please check the request and try again",
    correlation_id,
    retryable: status >= 500,
    field_errors: [] as unknown[],
  };
}

export function correlationOf(req: FastifyRequest): string {
  const header = req.headers["x-correlation-id"];
  return typeof header === "string" && header.length > 0 ? header : randomUUID();
}

export function sendAdminError(reply: FastifyReply, code: string, correlation: string): void {
  const status = ADMIN_ERROR_STATUS[code] ?? 400;
  reply.code(status).type("application/problem+json").send(adminProblem(code, correlation, status));
}

/** Authenticates the caller as an admin. On failure, writes a DENIED audit record (actor unknown) and replies with the error. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply, ctx: AdminRouteContext, actionType: string, targetType: string): Promise<AdminPrincipal | undefined> {
  const correlation = correlationOf(req);
  try {
    return await authenticateAdmin(req.headers.authorization, ctx.iesKey, ctx.iesIssuer, ctx.tenantSecret);
  } catch (error) {
    const code = error instanceof AdminAuthError ? error.code : "AUTHENTICATION_EXPIRED";
    await withAdminTransaction((client) =>
      writeAudit(client, { actorPseudonym: "anonymous", actorRole: "unknown", actionType, targetType, outcome: "DENIED", reason: code, correlationId: correlation }),
    ).catch(() => undefined);
    sendAdminError(reply, code, correlation);
    return undefined;
  }
}

/** Runs a membership/authorisation check; on failure writes a DENIED audit with the known actor and replies with the error. */
export async function requireAuthorised(
  req: FastifyRequest,
  reply: FastifyReply,
  principal: AdminPrincipal,
  actionType: string,
  targetType: string,
  targetId: string | undefined,
  check: () => Promise<void>,
): Promise<boolean> {
  const correlation = correlationOf(req);
  try {
    await check();
    return true;
  } catch (error) {
    const code = error instanceof AdminAuthError ? error.code : "MEMBERSHIP_NOT_PERMITTED";
    await withAdminTransaction((client) =>
      writeAudit(client, { actorPseudonym: principal.pseudonym, actorRole: principal.role, actionType, targetType, targetId, outcome: "DENIED", reason: code, correlationId: correlation }),
    ).catch(() => undefined);
    sendAdminError(reply, code, correlation);
    return false;
  }
}

export function requireIdempotencyKey(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length === 0) {
    sendAdminError(reply, "IDEMPOTENCY_KEY_REQUIRED", correlationOf(req));
    return undefined;
  }
  return key;
}

export type { AdminPrincipal, QueryableClient };
export { withAdminTransaction, writeAudit, AdminAuthError };
