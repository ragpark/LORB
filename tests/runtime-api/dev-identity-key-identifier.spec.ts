/**
 * The development provider names its key after the key, not after itself.
 *
 * Its key pair is generated at startup, so every restart is a rotation whether or not anybody
 * intended one. The identifier stamped on tokens was a constant, which meant a restart published a
 * new key under the old name.
 *
 * That is the one rotation a relying party cannot follow. `createRemoteJWKSet` caches the key set and
 * refetches when a token names a `kid` it does not hold; a token whose `kid` it *does* hold is
 * verified against the cached key and fails on the signature, with no refetch. So after an identity
 * restart every sign-in returned a 401 that reads like an expired token, until the cache aged out —
 * ten minutes, by the Runtime API's configuration. Nothing in the logs of either service says why.
 *
 * A thumbprint fixes it by construction: a new key cannot reuse an old name.
 */
import { readFileSync } from "node:fs";
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { DEV_IDENTITY_KID, issueIesToken } from "../../packages/dev-identity/src/issuer.js";
import { devJwks } from "../../packages/dev-identity/src/jwks.js";

const ISSUER = "https://identity.restart.test";

/** One run of the provider: a fresh key pair, named the way the server names it. */
async function providerInstance() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return {
    kid,
    jwks: devJwks(jwk, kid),
    token: (subject: string) => issueIesToken(privateKey, subject, "lorb-runtime", ISSUER, {}, kid),
    tokenUnderFixedName: (subject: string) => issueIesToken(privateKey, subject, "lorb-runtime", ISSUER, {}, DEV_IDENTITY_KID),
  };
}

const verifyAgainst = (jwks: { keys: unknown[] }, token: string) =>
  jwtVerify(token, createLocalJWKSet(jwks as never), { issuer: ISSUER, audience: "lorb-runtime" });

describe("a restart of the development identity provider", () => {
  it("publishes a different key identifier than the run before it", async () => {
    const [before, after] = [await providerInstance(), await providerInstance()];
    expect(after.kid).not.toBe(before.kid);
  });

  it("leaves a cached key set unable to match the new tokens, which is what makes it refetch", async () => {
    const before = await providerInstance();
    const after = await providerInstance();

    // The relying party still holds the key set it fetched before the restart.
    await expect(verifyAgainst(before.jwks, await after.token("learner-after-restart")))
      .rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
  });

  it("would instead fail on the signature — silently, and without refetching — under a fixed name", async () => {
    const before = await providerInstance();
    const after = await providerInstance();

    // The regression this guards against: same name, different key. jose finds the cached key by
    // `kid`, verifies against it, and reports a bad signature rather than a missing key.
    await expect(verifyAgainst(devJwks(before.jwks.keys[0]!, DEV_IDENTITY_KID), await after.tokenUnderFixedName("learner")))
      .rejects.toMatchObject({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
  });

  it("still verifies against the key set published by the run that issued the token", async () => {
    const provider = await providerInstance();
    const { payload } = await verifyAgainst(provider.jwks, await provider.token("learner-same-run"));
    expect(payload.sub).toBe("learner-same-run");
  });

  it("is what the running provider actually does: the identifier comes from the key", () => {
    // Asserted from the source because the server listens on import, so a test cannot start two of
    // them. What matters is that the identifier is derived rather than named.
    const server = readFileSync("packages/dev-identity/src/server.ts", "utf8");
    expect(server).toMatch(/const kid = await calculateJwkThumbprint\(publicJwk\)/);
    // Named in the comment above it, which is why this looks for the import rather than the text.
    expect(server, "the provider must not import the fixed placeholder identifier")
      .not.toMatch(/^import .*\bDEV_IDENTITY_KID\b/m);
  });
});
