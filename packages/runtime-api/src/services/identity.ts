/**
 * Access-token verification against the configured identity provider.
 *
 * LORB does not issue identities and does not become an identity provider; it consumes access tokens
 * from one it is configured to trust. What changes for production is which providers that can be: the
 * MVP hard-coded ES256 and a single locally-run synthetic issuer, which is neither what a real
 * provider signs with (RS256, usually) nor something a deployment should be able to fall back to.
 *
 * The verifier below takes issuer, audience, algorithms and JWKS location from configuration,
 * caches the remote key set (jose refreshes it on an unknown `kid`, which is how provider key
 * rotation is absorbed without a redeploy), and reports a subject plus the role claims the
 * administration surface needs.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type KeyLike } from "jose";
import type { IdentityProviderConfig } from "../config/index.js";

export class IdentityError extends Error {
  constructor(readonly code: "AUTHENTICATION_EXPIRED" | "ACCESS_DENIED") {
    super(code);
  }
}

export interface VerifiedPrincipal {
  subject: string;
  issuer: string;
  role?: string;
  platformAdmin: boolean;
  scopes: string[];
  claims: JWTPayload;
}

/** A resolvable key set: a remote JWKS in a deployment, or a key object injected by a test. */
export type KeyResolver = ReturnType<typeof createRemoteJWKSet> | KeyLike;

export interface TokenVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly keys: KeyResolver;
  verify(authorizationHeader: string | undefined): Promise<VerifiedPrincipal>;
}

function bearer(header: string | undefined): string {
  if (typeof header !== "string") throw new IdentityError("AUTHENTICATION_EXPIRED");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) throw new IdentityError("AUTHENTICATION_EXPIRED");
  return match[1];
}

function scopesOf(payload: JWTPayload): string[] {
  const raw = (payload as { scope?: unknown; scp?: unknown }).scope ?? (payload as { scp?: unknown }).scp;
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  return [];
}

/**
 * Reads a role from the configured claim, tolerating the two shapes providers actually emit: a plain
 * string, and an array of role strings (Auth0 and Entra both do the latter for role assignments).
 */
function roleOf(payload: JWTPayload, claim: string, allowed: string[]): string | undefined {
  const raw = (payload as Record<string, unknown>)[claim];
  if (typeof raw === "string") return allowed.includes(raw) ? raw : undefined;
  if (Array.isArray(raw)) return raw.find((value): value is string => typeof value === "string" && allowed.includes(value));
  return undefined;
}

export function allowedAdminRoles(): string[] {
  return (process.env.ADMIN_ALLOWED_ROLES ?? "admin").split(",").map((role) => role.trim()).filter(Boolean);
}

export function createTokenVerifier(identity: IdentityProviderConfig, injectedKeys?: KeyResolver): TokenVerifier {
  const keys: KeyResolver = injectedKeys ?? createRemoteJWKSet(new URL(identity.jwksUrl), {
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });

  return {
    issuer: identity.issuer,
    audience: identity.audience,
    keys,
    async verify(authorizationHeader) {
      const token = bearer(authorizationHeader);
      let payload: JWTPayload;
      try {
        payload = (await jwtVerify(token, keys as never, {
          issuer: identity.issuer,
          audience: identity.audience,
          algorithms: identity.algorithms,
          // A little clock tolerance, because a provider and this service will not agree to the
          // second and a learner losing a launch to 900ms of drift is not an acceptable failure.
          clockTolerance: 30,
        })).payload;
      } catch {
        throw new IdentityError("AUTHENTICATION_EXPIRED");
      }
      if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new IdentityError("AUTHENTICATION_EXPIRED");
      return {
        subject: payload.sub,
        issuer: identity.issuer,
        role: roleOf(payload, identity.roleClaim, allowedAdminRoles()),
        platformAdmin: (payload as Record<string, unknown>)[identity.platformAdminClaim] === true,
        scopes: scopesOf(payload),
        claims: payload,
      };
    },
  };
}
