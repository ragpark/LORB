/**
 * The descriptor signing key ring.
 *
 * A launch descriptor is verified by the Player Shell, by the Evidence API, and by anything else
 * that trusts the Runtime's JWKS. Generating a keypair per process made all three true only by
 * accident: one replica could not verify another replica's descriptor, and a restart invalidated
 * every descriptor in flight. Keys are therefore configured, shared by every replica, and rotated
 * with an overlap window rather than a cut-over.
 *
 * During a rotation the ring holds one ACTIVE key, which signs, and one or more RETIRING keys, which
 * no longer sign but stay in the JWKS and stay accepted on verification until the last descriptor
 * they signed has expired. Descriptor lifetime is minutes, so the overlap needs to be short — but it
 * cannot be zero.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK, type JWTVerifyResult, type KeyLike } from "jose";
import type { SigningKeyConfig } from "../config/index.js";

export interface RingKey {
  kid: string;
  state: "ACTIVE" | "RETIRING";
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
}

export class SigningKeyRing {
  private readonly byKid = new Map<string, RingKey>();
  private readonly active: RingKey;

  private constructor(keys: RingKey[]) {
    const active = keys.find((key) => key.state === "ACTIVE");
    if (!active) throw new Error("the signing key ring needs exactly one ACTIVE key");
    this.active = active;
    for (const key of keys) this.byKid.set(key.kid, key);
  }

  /** Builds a ring from configured PEM material. */
  static async fromConfig(configured: SigningKeyConfig[]): Promise<SigningKeyRing> {
    const keys: RingKey[] = [];
    for (const entry of configured) {
      let privateKeyObject: KeyObject;
      try {
        privateKeyObject = createPrivateKey(entry.pem);
      } catch (error) {
        throw new Error(`descriptor signing key "${entry.kid}" is not a readable PEM private key: ${(error as Error).message}`);
      }
      if (privateKeyObject.asymmetricKeyType !== "ec") {
        throw new Error(`descriptor signing key "${entry.kid}" must be an EC P-256 key for ES256`);
      }
      const publicKeyObject = createPublicKey(privateKeyObject);
      keys.push({
        kid: entry.kid,
        state: entry.state,
        privateKey: privateKeyObject as unknown as KeyLike,
        publicKey: publicKeyObject as unknown as KeyLike,
        publicJwk: { ...(await exportJWK(publicKeyObject)), kid: entry.kid, alg: "ES256", use: "sig" },
      });
    }
    return new SigningKeyRing(keys);
  }

  /**
   * An ephemeral ring for development and test only. Callers outside those environments are refused
   * by configuration long before they reach this, but the kid is deliberately self-describing so an
   * ephemeral key is obvious in a JWKS someone is looking at.
   */
  static async ephemeral(kid = "ephemeral-dev-key"): Promise<SigningKeyRing> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    return new SigningKeyRing([
      { kid, state: "ACTIVE", privateKey, publicKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } },
    ]);
  }

  get activeKid(): string {
    return this.active.kid;
  }

  get signingKey(): KeyLike {
    return this.active.privateKey;
  }

  /** Every key that a relying party may still need, newest-signing key first. */
  jwks(): { keys: JWK[] } {
    return { keys: [this.active.publicJwk, ...[...this.byKid.values()].filter((key) => key !== this.active).map((key) => key.publicJwk)] };
  }

  publicKeyFor(kid: string | undefined): KeyLike | undefined {
    if (!kid) return undefined;
    return this.byKid.get(kid)?.publicKey;
  }

  async sign(payload: Record<string, unknown>, header: Record<string, unknown>): Promise<string> {
    return new SignJWT(payload).setProtectedHeader({ ...header, alg: "ES256", kid: this.active.kid } as never).sign(this.active.privateKey);
  }

  /**
   * Verifies against the key the token names. Resolving by `kid` rather than trying every key means a
   * token signed by a key that has left the ring fails immediately instead of being probed against
   * keys it was never meant for.
   */
  async verify(token: string, options: { issuer: string; audience: string }): Promise<JWTVerifyResult> {
    return jwtVerify(token, async (header) => {
      const key = this.publicKeyFor(header.kid);
      if (!key) throw new Error("UNKNOWN_SIGNING_KEY");
      return key as never;
    }, { issuer: options.issuer, audience: options.audience, algorithms: ["ES256"] });
  }
}
