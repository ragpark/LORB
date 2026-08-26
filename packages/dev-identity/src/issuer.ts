import { SignJWT, type KeyLike } from "jose";

/**
 * The key identifier used when the caller does not supply one — the tests, which hand the Runtime
 * API the verification key directly and so never resolve by `kid`.
 *
 * The running provider does not use it. Its key pair is generated at startup and therefore changes
 * every time the process restarts, so a fixed identifier would name two different keys over a
 * deployment's life. A relying party caches a JWKS by `kid`: it would keep the key it fetched before
 * the restart, match the new tokens' `kid` against it, and fail the signature — a 401 that reads like
 * an expiry, for as long as the cache holds. Naming the key after itself makes a restart produce an
 * identifier the relying party has never seen, which is the one thing that makes it refetch.
 */
export const DEV_IDENTITY_KID = "dev-identity-001";

export const issueIesToken = (
  key: KeyLike,
  subject: string,
  audience = "lorb-runtime",
  issuer = "http://localhost:4000",
  claims: Record<string, unknown> = {},
  kid = DEV_IDENTITY_KID,
) =>
  new SignJWT({ sub: subject, ...claims })
    .setProtectedHeader({ alg: "ES256", kid, typ: "lorb-runtime+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
