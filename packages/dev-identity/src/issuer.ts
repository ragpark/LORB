import { SignJWT, type KeyLike } from "jose";

/**
 * The key identifier this provider stamps on every token, and publishes in its JWKS. The two must
 * agree: a relying party resolves the verification key by `kid`, so a mismatch produces
 * `ERR_JWKS_NO_MATCHING_KEY` and a 401 that reads like an expiry or an audience problem.
 */
export const DEV_IDENTITY_KID = "dev-identity-001";

export const issueIesToken = (
  key: KeyLike,
  subject: string,
  audience = "lorb-runtime",
  issuer = "http://localhost:4000",
  claims: Record<string, unknown> = {},
) =>
  new SignJWT({ sub: subject, ...claims })
    .setProtectedHeader({ alg: "ES256", kid: DEV_IDENTITY_KID, typ: "lorb-runtime+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
