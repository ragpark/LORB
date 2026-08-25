/**
 * The runtime system of record.
 *
 * Everything the Runtime and Evidence APIs mutate goes through this interface, so the same code path
 * runs against Postgres in a deployed environment and against an in-process implementation in the
 * test suites. The interface is asynchronous throughout — not because the in-memory implementation
 * needs it, but because a synchronous store is exactly what tied the previous implementation to one
 * process.
 */

export type AttemptStatus = "CREATED" | "STARTED" | "SUSPENDED" | "RESUMED" | "COMPLETED" | "ABANDONED" | "EXPIRED" | "VOIDED";

export interface GoverningLaunchPolicy {
  launch_policy_id: string;
  launch_policy_version_id: string;
  display_name: string;
  semver: string;
}

export interface Attempt {
  attempt_id: string;
  repository_id: string;
  object_id: string;
  object_version_id: string;
  package_version_id: string;
  /** The pseudonymous subject. A learner's platform identifier is never stored on an attempt. */
  pseudonym: string;
  consumer_id: string;
  status: AttemptStatus;
  revision: number;
  state?: unknown;
  correlation_id: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  terminated_at?: string | null;
  expires_at?: string | null;
  governed_by_launch_policy?: GoverningLaunchPolicy;
  package_pinned_by_object?: boolean;
  source: "consumer" | "smart-link" | "assignment";
}

export interface LaunchRecord {
  launch_id: string;
  attempt_id: string;
  repository_id: string;
  object_id: string;
  consumer_id: string;
  launch_mode: string;
  expires_at: string;
  correlation_id: string;
}

export type OutboxStatus = "PENDING" | "IN_FLIGHT" | "FORWARDED" | "FAILED" | "DEAD_LETTER";

export interface OutboxRow {
  outbox_id: string;
  statement_id: string;
  repository_id: string;
  attempt_id: string | null;
  package_version_id: string;
  object_id: string | null;
  actor_pseudonym: string | null;
  verb_id: string | null;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  forwarded_at: string | null;
  next_attempt_at: string;
  dead_lettered_at: string | null;
  correlation_id: string;
}

export interface Assignment {
  assignment_id: string;
  object_id: string;
  created_at: string;
  source: string;
  created_by_pseudonym?: string | null;
  pseudonyms: string[];
}

export interface SmartLink {
  smart_link_id: string;
  object_id: string;
  /** Present only on the response to the request that created the link; never read back from store. */
  token?: string;
  token_prefix: string;
  created_by_pseudonym: string;
  created_at: string;
  revoked_at: string | null;
  last_redeemed_at: string | null;
  redemption_count: number;
}

export interface IdempotentReplay {
  status_code: number;
  response: unknown;
  /** True when the stored request differs from the one being replayed under the same key. */
  mismatch: boolean;
}

export interface AttemptFilter {
  repository_id?: string;
  object_id?: string;
  pseudonym?: string;
  status?: AttemptStatus;
  limit?: number;
}

export interface StateWriteResult {
  outcome: "APPLIED" | "CONFLICT" | "NOT_FOUND";
  revision?: number;
  status?: AttemptStatus;
}

export interface RuntimeStore {
  readonly kind: "postgres" | "memory";

  /** Liveness of the underlying storage, for the readiness probe. */
  ping(): Promise<void>;
  close(): Promise<void>;

  createAttempt(attempt: Attempt): Promise<void>;
  getAttempt(attemptId: string): Promise<Attempt | undefined>;
  listAttempts(filter: AttemptFilter): Promise<Attempt[]>;
  /**
   * Writes attempt state under optimistic concurrency: the caller states the revision it read, and a
   * write against a stale revision is refused rather than silently overwriting a concurrent one.
   */
  writeAttemptState(attemptId: string, expectedRevision: number, state: unknown): Promise<StateWriteResult>;
  transitionAttempt(attemptId: string, next: AttemptStatus): Promise<StateWriteResult>;
  /** Terminates attempts whose session window has passed. Returns how many were moved. */
  expireStaleAttempts(now?: Date): Promise<number>;

  recordLaunch(launch: LaunchRecord): Promise<void>;

  /**
   * Returns a previously stored response for this key, or undefined when the key is new. A stored
   * response whose request fingerprint differs is reported as a mismatch so the caller can refuse it
   * instead of replaying somebody else's answer.
   */
  replayIdempotent(scope: string, key: string, fingerprint: string): Promise<IdempotentReplay | undefined>;
  recordIdempotent(scope: string, key: string, fingerprint: string, statusCode: number, response: unknown, ttlMs: number): Promise<void>;
  purgeExpiredIdempotency(now?: Date): Promise<number>;

  /** Returns false when the statement id was already accepted, which is the xAPI dedup rule. */
  enqueueStatement(row: Omit<OutboxRow, "status" | "attempts" | "last_error" | "forwarded_at" | "next_attempt_at" | "dead_lettered_at">): Promise<boolean>;
  listOutbox(filter: { status?: OutboxStatus; object_id?: string; limit?: number }): Promise<OutboxRow[]>;
  getOutbox(outboxId: string): Promise<OutboxRow | undefined>;
  getOutboxByStatement(statementId: string): Promise<OutboxRow | undefined>;
  /** Requeues a failed or dead-lettered statement. Returns false when the row is not requeueable. */
  requeueStatement(outboxId: string, statementId: string): Promise<boolean>;
  /** Atomically takes ownership of due statements so replicas do not deliver the same one twice. */
  claimDueStatements(worker: string, limit: number, now?: Date): Promise<OutboxRow[]>;
  markForwarded(outboxId: string): Promise<void>;
  markDeliveryFailed(outboxId: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void>;
  /** Statements for one activity, used by the teacher-facing read model. */
  statementsForObject(objectId: string, since?: string): Promise<OutboxRow[]>;

  recordAssignment(assignment: Assignment): Promise<void>;
  assignmentsForObject(objectId: string): Promise<Assignment[]>;

  createSmartLink(link: SmartLink & { token_hash: string }): Promise<void>;
  smartLinkByTokenHash(tokenHash: string): Promise<SmartLink | undefined>;
  activeSmartLinkForObject(objectId: string): Promise<SmartLink | undefined>;
  revokeSmartLink(objectId: string, revokedByPseudonym: string): Promise<SmartLink | undefined>;
  recordSmartLinkRedemption(smartLinkId: string): Promise<void>;

  recordHeartbeat(worker: string, instance: string, detail?: unknown): Promise<void>;
  heartbeats(): Promise<{ worker: string; instance: string; last_seen_at: string; detail: unknown }[]>;
}
