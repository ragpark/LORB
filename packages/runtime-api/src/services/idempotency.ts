/**
 * Idempotency, applied the way a retry actually arrives.
 *
 * Every state-changing surface here requires an `Idempotency-Key`, and for a while requiring it was
 * all some of them did: the key was checked for presence, the work ran, and the response was stored
 * afterwards under a unique constraint. That is not idempotency. Two replicas handling the same key
 * at the same moment both see no stored response, both do the work — two attempts, two launches, two
 * learning objects — and only then race to store one of the two answers, with the unique constraint
 * quietly discarding the other. The caller sees one response and believes one thing happened.
 *
 * So the key is claimed *before* the work. Exactly one caller is told to proceed; every other is
 * told what the key is already doing — replaying a finished response, refusing a different request
 * under a used key, or reporting the first request still in flight. A claim whose work does not
 * produce a response is released, so a caller whose own request was rejected can correct it and
 * retry rather than being locked out for the record's lifetime.
 */
import { createHash } from "node:crypto";
import type { RuntimeStore } from "../store/index.js";

/**
 * What "the same request" means for a key. A retry of the identical body replays; the same key with
 * a different body is refused rather than being handed somebody else's answer.
 */
export const requestFingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

/** How long a stored response stays replayable. Long enough for a client's retry policy to finish. */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function idempotencyTtlMs(): number {
  const raw = Number.parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_IDEMPOTENCY_TTL_MS;
}

export interface IdempotencyHandlers<T> {
  /** The key was used for a different request body. */
  mismatch: () => T;
  /** Another caller holds the key and has not produced a response yet. */
  inFlight: () => T;
  /** The work is already done; this is its answer. */
  replay: (statusCode: number, response: unknown) => T;
  /**
   * Runs the work. Call `complete` with the response that a retry should replay — and only with a
   * response that reflects work actually done, so a rejection releases the key instead of pinning
   * an error to it.
   */
  run: (complete: (statusCode: number, response: unknown) => Promise<void>) => Promise<T>;
}

export async function withIdempotencyClaim<T>(
  store: RuntimeStore,
  scope: string,
  key: string,
  fingerprint: string,
  handlers: IdempotencyHandlers<T>,
  ttlMs: number = idempotencyTtlMs(),
): Promise<T> {
  const claim = await store.claimIdempotent(scope, key, fingerprint, ttlMs);
  if (claim.state === "mismatch") return handlers.mismatch();
  if (claim.state === "in_flight") return handlers.inFlight();
  if (claim.state === "replay") return handlers.replay(claim.status_code, claim.response);

  let completed = false;
  try {
    return await handlers.run(async (statusCode, response) => {
      await store.completeIdempotent(scope, key, statusCode, response);
      completed = true;
    });
  } finally {
    if (!completed) await store.releaseIdempotent(scope, key).catch(() => undefined);
  }
}
