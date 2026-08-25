import type { AttemptStatus } from "./types.js";

/**
 * The attempt lifecycle, as a table rather than a chain of conditionals, so an illegal move is a
 * missing edge instead of a forgotten branch. Terminal states have no outgoing edges at all: once an
 * attempt is completed, abandoned, expired or voided, nothing reopens it — a correction is a new
 * attempt, never a rewrite of the old one.
 */
const LEGAL: Record<AttemptStatus, readonly AttemptStatus[]> = {
  CREATED: ["STARTED", "ABANDONED", "EXPIRED", "VOIDED"],
  STARTED: ["SUSPENDED", "COMPLETED", "ABANDONED", "EXPIRED", "VOIDED"],
  SUSPENDED: ["RESUMED", "ABANDONED", "EXPIRED", "VOIDED"],
  RESUMED: ["SUSPENDED", "COMPLETED", "ABANDONED", "EXPIRED", "VOIDED"],
  COMPLETED: [],
  ABANDONED: [],
  EXPIRED: [],
  VOIDED: [],
};

export const TERMINAL_STATUSES: readonly AttemptStatus[] = ["COMPLETED", "ABANDONED", "EXPIRED", "VOIDED"];
export const OPEN_STATUSES: readonly AttemptStatus[] = ["CREATED", "STARTED", "SUSPENDED", "RESUMED"];

export function isLegalTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

/** Mutates in place and throws ATTEMPT_CONFLICT on an illegal move, matching the error taxonomy. */
export function transition(attempt: { status: AttemptStatus }, next: AttemptStatus): void {
  if (!isLegalTransition(attempt.status, next)) throw new Error("ATTEMPT_CONFLICT");
  attempt.status = next;
}
