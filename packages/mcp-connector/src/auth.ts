// AGENT-FACING TRUST DOMAIN — NOT PRODUCTION — BLOCKED BY BLK-08. See config.ts.
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { ConnectorConfig, OidcConfig } from "./config.js";

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
  error?: "invalid_request" | "invalid_token" | "insufficient_scope";
  /** Subject of a validated token, for logging. Never a raw credential. */
  subject?: string;
}

/**
 * Asymmetric algorithms only, as defence in depth.
 *
 * The attacks this guards against are `none` (no key needed) and HMAC (anyone holding the *public*
 * JWKS material could mint an accepted token). In practice jose's JWKS key resolution already
 * refuses both, because neither can resolve to a signing key published in a JWKS — so this list is a
 * second line, not the only one. It is stated explicitly anyway: relying on a library's incidental
 * behaviour for a security property is how that property gets lost in an upgrade.
 *
 * EdDSA is included because it is asymmetric and safe; excluding it would reject a legitimate
 * provider for no benefit.
 */
const ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

export type TokenVerifier = (authorization: unknown) => Promise<AuthOutcome>;

/** Splits an OAuth `scope` claim, tolerating the array form some providers emit. */
function scopesOf(payload: JWTPayload): string[] {
  const raw = (payload as { scope?: unknown; scp?: unknown }).scope ?? (payload as { scp?: unknown }).scp;
  if (typeof raw === "string") return raw.split(" ").filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  return [];
}

/**
 * Validates a token issued by an external identity provider. This connector is a resource server:
 * it verifies and nothing else. It never issues, refreshes, stores, or exchanges a credential, and
 * it holds no client secret.
 *
 * `audience` is the load-bearing check. Without it, any token the same provider minted for any other
 * service in the tenant would open this one — the confused-deputy problem the MCP authorization
 * spec calls out. It is required configuration precisely so it cannot be forgotten.
 */
export function createOidcVerifier(oidc: OidcConfig): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
  return async (authorization: unknown): Promise<AuthOutcome> => {
    const presented = bearerFrom(authorization);
    if (!presented) return { ok: false, error: "invalid_request" };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(presented, jwks, {
        issuer: oidc.issuer,
        audience: oidc.audience,
        algorithms: ALLOWED_ALGORITHMS,
      }));
    } catch {
      // Deliberately opaque: which of signature, issuer, audience or expiry failed is not the
      // caller's business, and saying would help someone probe for a token this server will take.
      return { ok: false, error: "invalid_token" };
    }
    if (oidc.requiredScope && !scopesOf(payload).includes(oidc.requiredScope)) {
      return { ok: false, error: "insufficient_scope" };
    }
    return { ok: true, subject: typeof payload.sub === "string" ? payload.sub : undefined };
  };
}

/** Pre-shared bearer token. Local dev and CI only — there is no identity provider behind it. */
export function createPocVerifier(expected: string): TokenVerifier {
  return async (authorization: unknown): Promise<AuthOutcome> => {
    const presented = bearerFrom(authorization);
    if (!presented) return { ok: false, error: "invalid_request" };
    if (!tokenMatches(presented, expected)) return { ok: false, error: "invalid_token" };
    return { ok: true };
  };
}

export const createVerifier = (config: ConnectorConfig): TokenVerifier =>
  config.oidc ? createOidcVerifier(config.oidc) : createPocVerifier(config.agentBearerToken);

/** RFC 9728 §3. Path is fixed by the spec; clients look for it without being told. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 §3.1 forms the metadata URL by inserting the well-known path *between* the host and the
 * resource's own path, so a resource served at `https://host/mcp` publishes at
 * `https://host/.well-known/oauth-protected-resource/mcp`. Clients that follow the
 * `resource_metadata` pointer never construct this; clients that construct it never see the
 * pointer. Serving both costs one route and removes a whole class of "discovery 404" failures.
 */
export const PROTECTED_RESOURCE_METADATA_PATH_INSERTED = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`;

export const protectedResourceMetadataUrl = (oidc: OidcConfig) =>
  `${oidc.publicUrl}${PROTECTED_RESOURCE_METADATA_PATH_INSERTED}`;

/**
 * RFC 9728 protected resource metadata. This is how a client discovers *which* authorization server
 * to go to; it is the document whose absence made claude.ai's dynamic client registration fail.
 */
export const protectedResourceMetadata = (oidc: OidcConfig) => ({
  resource: oidc.audience,
  authorization_servers: [oidc.issuer],
  bearer_methods_supported: ["header"],
  ...(oidc.requiredScope ? { scopes_supported: [oidc.requiredScope] } : {}),
  resource_documentation: "https://github.com/ragpark/LORB/blob/main/packages/mcp-connector/README.md",
});

/**
 * RFC 6750 §3 challenge. In `oidc` mode it carries the `resource_metadata` pointer RFC 9728 §5.1
 * requires, which is what lets a client discover the authorization server rather than guess.
 */
export function wwwAuthenticate(error: AuthOutcome["error"], config: ConnectorConfig): string {
  const code = error ?? "invalid_token";
  const parts = [`Bearer realm="lorb-mcp-connector"`, `error="${code}"`];
  if (config.oidc) {
    parts.push(`resource_metadata="${protectedResourceMetadataUrl(config.oidc)}"`);
    if (config.oidc.requiredScope) parts.push(`scope="${config.oidc.requiredScope}"`);
    parts.push(`error_description="A token issued by the configured identity provider for this resource is required"`);
  } else {
    parts.push(`error_description="A valid pre-shared PoC bearer token is required"`);
  }
  return parts.join(", ");
}
