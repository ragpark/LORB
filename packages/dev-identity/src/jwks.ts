import type { JWK } from "jose";
import { DEV_IDENTITY_KID } from "./issuer.js";

/**
 * The development provider publishes exactly one key. A real provider publishes a set and rotates
 * it, which is why the Runtime API resolves by `kid` rather than assuming there is only ever one.
 */
export const devJwks = (key: JWK): { keys: JWK[] } => ({ keys: [{ ...key, kid: DEV_IDENTITY_KID, alg: "ES256", use: "sig" }] });
