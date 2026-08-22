// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — BLOCKED BY BLK-08. See config.ts.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison over fixed-width digests, so token length is not observable. */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerFrom(authorization: unknown): string | undefined {
  if (typeof authorization !== "string") return undefined;
  // The MCP authorization spec requires the `Bearer` scheme, matched case-insensitively.
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

export interface AuthOutcome {
  ok: boolean;
  /** RFC 6750 error code, for the WWW-Authenticate challenge. */
  error?: "invalid_request" | "invalid_token";
}

export function authenticateAgent(authorization: unknown, expected: string): AuthOutcome {
  const presented = bearerFrom(authorization);
  if (!presented) return { ok: false, error: "invalid_request" };
  if (!tokenMatches(presented, expected)) return { ok: false, error: "invalid_token" };
  return { ok: true };
}

/**
 * MCP-spec-shaped challenge. This connector is PoC-grade: it does **not** implement the OAuth 2.1
 * authorization-server discovery, protected-resource metadata, or token exchange the MCP
 * authorization specification requires of a production remote server. It carries one pre-shared
 * bearer token per environment. Wiring a real IdP is out of scope here and is gated on BLK-08.
 */
export const wwwAuthenticate = (error: AuthOutcome["error"]): string =>
  `Bearer realm="lorb-mcp-connector", error="${error ?? "invalid_token"}", error_description="A valid pre-shared PoC bearer token is required"`;
