// Administration RBAC and repository-scoped ABAC.
import { jwtVerify } from "jose";
import { computePseudonym } from "./pseudonym-service.js";
import { allowedAdminRoles } from "./identity.js";

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

export interface AdminAuthOptions {
  /** The audience the provider mints Runtime tokens for. */
  audience?: string;
  /** Signature algorithms the provider is configured to use; RS256 for most real providers. */
  algorithms?: string[];
  /** Claim carrying the platform role, where a provider is configured to emit a non-default one. */
  roleClaim?: string;
  platformAdminClaim?: string;
}

/**
 * Reads a role from the configured claim, accepting both shapes providers emit: a single string, and
 * an array of assigned roles.
 */
function roleFrom(payload: Record<string, unknown>, claim: string, allowed: string[]): string | undefined {
  const raw = payload[claim];
  if (typeof raw === "string") return allowed.includes(raw) ? raw : undefined;
  if (Array.isArray(raw)) return raw.find((value): value is string => typeof value === "string" && allowed.includes(value));
  return undefined;
}

export async function authenticateAdmin(
  authorizationHeader: string | undefined,
  identityKey: unknown,
  identityIssuer: string,
  tenantSecret: Buffer,
  options: AdminAuthOptions = {},
): Promise<AdminPrincipal> {
  const token = authorizationHeader?.replace(/^Bearer /, "");
  if (!token) throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  let payload;
  try {
    payload = (await jwtVerify(token, identityKey as never, {
      issuer: identityIssuer,
      audience: options.audience ?? "lorb-runtime",
      algorithms: options.algorithms ?? ["ES256", "RS256"],
      clockTolerance: 30,
    })).payload;
  } catch {
    throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  }
  const sub = payload.sub as string | undefined;
  if (!sub) throw new AdminAuthError("AUTHENTICATION_EXPIRED");
  const role = roleFrom(payload as Record<string, unknown>, options.roleClaim ?? process.env.OIDC_ROLE_CLAIM ?? "role", allowedAdminRoles());
  if (!role) throw new AdminAuthError("ADMIN_AUDIT_DENIED");
  const pseudonym = computePseudonym(tenantSecret, identityIssuer, sub, "admin");
  return { pseudonym, role, platformAdmin: (payload as Record<string, unknown>)[options.platformAdminClaim ?? process.env.OIDC_PLATFORM_ADMIN_CLAIM ?? "platform_admin"] === true };
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
