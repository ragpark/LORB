// Administration route helpers: authentication, authorisation, audit and the error contract.
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminAuthError, authenticateAdmin, type AdminPrincipal } from "../../services/admin-authz.js";
import { writeAudit, type QueryableClient } from "../../services/audit-writer.js";
import { withAdminTransaction } from "../../db/pool.js";

export interface AdminRouteContext {
  /** Key material for the configured identity provider: a remote JWKS, or an injected key in tests. */
  iesKey: unknown;
  iesIssuer: string;
  tenantSecret: Buffer;
  playerModuleOriginAllowlist: string[];
  /** The audience the provider mints Runtime tokens for. Defaults to lorb-runtime. */
  audience?: string;
  /** Signature algorithms accepted from the provider. */
  algorithms?: string[];
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
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_IN_FLIGHT: 409,
  LEARNING_OBJECT_NOT_FOUND: 404,
  LEARNING_OBJECT_NOT_PUBLISHED: 409,
  SMART_LINK_NOT_FOUND: 404,
  CLASS_NOT_FOUND: 404,
  CLASS_REQUEST_INVALID: 400,
  CLASS_EMPTY: 409,
  LEARNER_REF_INVALID: 400,
  LEARNER_NOT_FOUND: 404,
  AGENT_LINK_INVALID: 400,
  AGENT_LINK_TAKEN: 409,
  AGENT_LINK_NOT_FOUND: 404,
};

const ADMIN_ERROR_TITLE: Record<string, string> = {
  IDEMPOTENCY_KEY_REUSED: "That idempotency key was used for a different request",
  IDEMPOTENCY_KEY_IN_FLIGHT: "That idempotency key is still being processed",
  AUTHENTICATION_EXPIRED: "Your session has expired",
  ADMIN_AUDIT_DENIED: "Administrator access is required",
  MEMBERSHIP_NOT_PERMITTED: "You do not have the required repository membership",
  SEPARATION_OF_DUTIES_REQUIRED: "A different administrator must approve this request",
  APPROVAL_REQUIRED: "This action requires an approved request first",
  APPROVAL_NOT_FOUND: "Approval request not found",
  PLAYER_VERSION_IMMUTABLE: "This player version is immutable",
  LAUNCH_POLICY_VERSION_IMMUTABLE: "This launch policy version is immutable",
  LEARNING_OBJECT_NOT_FOUND: "Learning object not found",
  LEARNING_OBJECT_NOT_PUBLISHED: "Only published learning objects can have a smart link",
  SMART_LINK_NOT_FOUND: "Smart link not found",
  CLASS_NOT_FOUND: "Class not found",
  CLASS_EMPTY: "Add at least one learner to the class before assigning work",
  LEARNER_REF_INVALID: "One or more learner identifiers are not in a supported shape",
  LEARNER_NOT_FOUND: "That learner is not in this class",
  AGENT_LINK_TAKEN: "That assistant is already linked to another account",
  AGENT_LINK_NOT_FOUND: "That assistant is not linked to your account",
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
    return await authenticateAdmin(req.headers.authorization, ctx.iesKey, ctx.iesIssuer, ctx.tenantSecret, { audience: ctx.audience, algorithms: ctx.algorithms });
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
