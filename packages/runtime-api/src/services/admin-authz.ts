// STUB — NOT PRODUCTION — BLOCKED BY BLK-03, BLK-07, BLK-08, BLK-09, BLK-11. Administration workspace Wave 1 RBAC/ABAC.
import { jwtVerify } from "jose";
import { computePseudonym } from "./pseudonym-service.js";

export class AdminAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface AdminPrincipal {
  pseudonym: string;
  role: string;
  platformAdmin: boolean;
}

export async function authenticateAdmin(
  authorizationHeader: string | undefined,
  iesKey: unknown,
  iesIssuer: string,
  tenantSecret: Buffer,
): Promise<AdminPrincipal> {
  const token = authorizationHeader?.replace(/^Bearer /, "");
  if (!token) throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  let payload;
  try {
    payload = (await jwtVerify(token, iesKey as never, { issuer: iesIssuer, audience: "lorb-runtime", algorithms: ["ES256"] })).payload;
  } catch {
    throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  }
  const sub = payload.sub as string | undefined;
  if (!sub) throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  const role = payload.role as string | undefined;
  const allowedRoles = (process.env.ADMIN_ALLOWED_ROLES ?? "admin").split(",").map((r) => r.trim()).filter(Boolean);
  if (!role || !allowedRoles.includes(role)) throw new AdminAuthError("ADMIN_AUDIT_DENIED");
  const pseudonym = computePseudonym(tenantSecret, iesIssuer, sub, "admin");
  return { pseudonym, role, platformAdmin: payload.platform_admin === true };
}

const membershipRank: Record<string, number> = { repository_reader: 1, repository_operator: 2, repository_owner: 3 };
export type RepositoryRole = keyof typeof membershipRank;

export async function requireRepositoryMembership(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { principal_role: string }[] }> },
  repositoryId: string,
  principal: AdminPrincipal,
  minimumRole: RepositoryRole,
): Promise<void> {
  if (principal.platformAdmin) return;
  const result = await client.query(
    "select principal_role from repository_membership where repository_id=$1 and principal_subject_pseudonym=$2 and revoked_at is null",
    [repositoryId, principal.pseudonym],
  );
  const best = result.rows.reduce((max, row) => Math.max(max, membershipRank[row.principal_role] ?? 0), 0);
  if (best < (membershipRank[minimumRole] ?? 0)) throw new AdminAuthError("MEMBERSHIP_NOT_PERMITTED");
}

export function approvalRequiredFor(actionType: string): boolean {
  return (process.env.ADMIN_APPROVAL_REQUIRED_FOR ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(actionType);
}
