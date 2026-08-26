import type { JWK } from "jose";
import { DEV_IDENTITY_KID } from "./issuer.js";

/**
 * The development provider publishes exactly one key. A real provider publishes a set and rotates
 * it, which is why the Runtime API resolves by `kid` rather than assuming there is only ever one.
 *
 * The identifier is a parameter because the provider's key is ephemeral: see DEV_IDENTITY_KID.
 */
export const devJwks = (key: JWK, kid = DEV_IDENTITY_KID): { keys: JWK[] } =>
  ({ keys: [{ ...key, kid, alg: "ES256", use: "sig" }] });
