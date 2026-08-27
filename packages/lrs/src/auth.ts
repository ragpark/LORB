/**
 * Who may write to the store.
 *
 * Comparison is constant-time and always runs over every configured credential: returning early on
 * the first mismatch, or comparing with `===`, leaks the credential a byte at a time to anyone who
 * can measure the response. The cost of checking all of them is a few microseconds against a list
 * that is realistically two entries long during a rotation.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { LrsCredential } from "./config.js";
import { credentialLabel } from "./store.js";

/** Fixed-width comparison: hashing first means two different lengths cannot short-circuit. */
function matches(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

export interface AuthenticatedCaller {
  kind: "basic" | "bearer";
  /** A hash prefix, so a log line can say which credential was used without saying what it is. */
  label: string;
}

export function authenticate(header: string | undefined, credentials: LrsCredential[]): AuthenticatedCaller | undefined {
  if (!header || credentials.length === 0) return undefined;

  let accepted: AuthenticatedCaller | undefined;
  if (/^Bearer /i.test(header)) {
    const token = header.slice(7);
    for (const credential of credentials) {
      if (credential.kind === "bearer" && matches(credential.token, token)) {
        accepted = { kind: "bearer", label: credentialLabel(credential.token) };
      }
    }
    return accepted;
  }

  if (/^Basic /i.test(header)) {
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      return undefined;
    }
    const separator = decoded.indexOf(":");
    if (separator <= 0) return undefined;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    for (const credential of credentials) {
      if (credential.kind === "basic" && matches(credential.username, username) && matches(credential.password, password)) {
        accepted = { kind: "basic", label: credentialLabel(`${credential.username}:${credential.password}`) };
      }
    }
    return accepted;
  }

  return undefined;
}
