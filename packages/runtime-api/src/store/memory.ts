/**
 * In-process implementation of the runtime store.
 *
 * It exists for the test suites and for `pnpm dev` without a database. It is not a deployment target:
 * configuration refuses to start a production process without DATABASE_URL, precisely so this
 * implementation can never become a system of record by accident.
 */
import { isLegalTransition, OPEN_STATUSES } from "./transitions.js";
import type {
  Assignment, Attempt, AttemptFilter, IdempotentReplay, LaunchRecord, OutboxRow, OutboxStatus,
  RuntimeStore, SmartLink, StateWriteResult,
} from "./types.js";

interface IdempotencyEntry { fingerprint: string; statusCode: number; response: unknown; expiresAt: number }

export class MemoryRuntimeStore implements RuntimeStore {
  readonly kind = "memory" as const;
  private readonly attempts = new Map<string, Attempt>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly outboxByStatement = new Map<string, OutboxRow>();
  private readonly assignments = new Map<string, Assignment>();
  private readonly smartLinksByHash = new Map<string, SmartLink & { token_hash: string }>();
  private readonly beats = new Map<string, { worker: string; instance: string; last_seen_at: string; detail: unknown }>();

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  /** Test seam. Drops every row so a suite starts from a known state. */
  reset(): void {
    this.attempts.clear();
    this.launches.clear();
    this.idempotency.clear();
    this.outboxByStatement.clear();
    this.assignments.clear();
    this.smartLinksByHash.clear();
    this.beats.clear();
  }

  async createAttempt(attempt: Attempt): Promise<void> {
    this.attempts.set(attempt.attempt_id, { ...attempt });
  }

  async getAttempt(attemptId: string): Promise<Attempt | undefined> {
    const attempt = this.attempts.get(attemptId);
    return attempt ? { ...attempt } : undefined;
  }

  async listAttempts(filter: AttemptFilter): Promise<Attempt[]> {
    let rows = [...this.attempts.values()];
    if (filter.repository_id) rows = rows.filter((row) => row.repository_id === filter.repository_id);
    if (filter.object_id) rows = rows.filter((row) => row.object_id === filter.object_id);
    if (filter.pseudonym) rows = rows.filter((row) => row.pseudonym === filter.pseudonym);
    if (filter.status) rows = rows.filter((row) => row.status === filter.status);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows.slice(0, filter.limit ?? 200).map((row) => ({ ...row }));
  }

  async writeAttemptState(attemptId: string, expectedRevision: number, state: unknown): Promise<StateWriteResult> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { outcome: "NOT_FOUND" };
    if (attempt.revision !== expectedRevision) return { outcome: "CONFLICT" };
    if (!OPEN_STATUSES.includes(attempt.status)) return { outcome: "CONFLICT" };
    attempt.state = state;
    attempt.revision += 1;
    if (attempt.status === "CREATED") {
      attempt.status = "STARTED";
      attempt.started_at = new Date().toISOString();
    } else if (attempt.status === "SUSPENDED") {
      attempt.status = "RESUMED";
    }
    return { outcome: "APPLIED", revision: attempt.revision, status: attempt.status };
  }

  async transitionAttempt(attemptId: string, next: Attempt["status"]): Promise<StateWriteResult> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { outcome: "NOT_FOUND" };
    if (!isLegalTransition(attempt.status, next)) return { outcome: "CONFLICT" };
    attempt.status = next;
    const now = new Date().toISOString();
    if (next === "COMPLETED") attempt.completed_at = now;
    if (next === "ABANDONED" || next === "EXPIRED" || next === "VOIDED") attempt.terminated_at = now;
    if (next === "STARTED" && !attempt.started_at) attempt.started_at = now;
    return { outcome: "APPLIED", revision: attempt.revision, status: attempt.status };
  }

  async expireStaleAttempts(now = new Date()): Promise<number> {
    let expired = 0;
    for (const attempt of this.attempts.values()) {
      if (!OPEN_STATUSES.includes(attempt.status)) continue;
      if (!attempt.expires_at || new Date(attempt.expires_at) > now) continue;
      attempt.status = "EXPIRED";
      attempt.terminated_at = now.toISOString();
      expired += 1;
    }
    return expired;
  }

  async recordLaunch(launch: LaunchRecord): Promise<void> {
    this.launches.set(launch.launch_id, { ...launch });
  }

  async replayIdempotent(scope: string, key: string, fingerprint: string): Promise<IdempotentReplay | undefined> {
    const entry = this.idempotency.get(`${scope} ${key}`);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.idempotency.delete(`${scope} ${key}`);
      return undefined;
    }
    return { status_code: entry.statusCode, response: entry.response, mismatch: entry.fingerprint !== fingerprint };
  }

  async recordIdempotent(scope: string, key: string, fingerprint: string, statusCode: number, response: unknown, ttlMs: number): Promise<void> {
    this.idempotency.set(`${scope} ${key}`, { fingerprint, statusCode, response, expiresAt: Date.now() + ttlMs });
  }

  async purgeExpiredIdempotency(now = new Date()): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.idempotency) {
      if (entry.expiresAt <= now.getTime()) {
        this.idempotency.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async enqueueStatement(row: Parameters<RuntimeStore["enqueueStatement"]>[0]): Promise<boolean> {
    if (this.outboxByStatement.has(row.statement_id)) return false;
    this.outboxByStatement.set(row.statement_id, {
      ...row,
      status: "PENDING",
      attempts: 0,
      last_error: null,
      forwarded_at: null,
      next_attempt_at: new Date().toISOString(),
      dead_lettered_at: null,
    });
    return true;
  }

  async listOutbox(filter: { status?: OutboxStatus; object_id?: string; limit?: number }): Promise<OutboxRow[]> {
    let rows = [...this.outboxByStatement.values()];
    if (filter.status) rows = rows.filter((row) => row.status === filter.status);
    if (filter.object_id) rows = rows.filter((row) => row.object_id === filter.object_id);
    return rows.slice(0, filter.limit ?? 500).map((row) => ({ ...row }));
  }

  async getOutbox(outboxId: string): Promise<OutboxRow | undefined> {
    const row = [...this.outboxByStatement.values()].find((candidate) => candidate.outbox_id === outboxId);
    return row ? { ...row } : undefined;
  }

  async getOutboxByStatement(statementId: string): Promise<OutboxRow | undefined> {
    const row = this.outboxByStatement.get(statementId);
    return row ? { ...row } : undefined;
  }

  async requeueStatement(outboxId: string, statementId: string): Promise<boolean> {
    const row = [...this.outboxByStatement.values()].find((candidate) => candidate.outbox_id === outboxId);
    if (!row || row.statement_id !== statementId) return false;
    if (row.status !== "FAILED" && row.status !== "DEAD_LETTER") return false;
    row.status = "PENDING";
    row.next_attempt_at = new Date().toISOString();
    row.dead_lettered_at = null;
    return true;
  }

  async claimDueStatements(worker: string, limit: number, now = new Date()): Promise<OutboxRow[]> {
    const due = [...this.outboxByStatement.values()]
      .filter((row) => (row.status === "PENDING" || row.status === "FAILED") && new Date(row.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
    for (const row of due) {
      row.status = "IN_FLIGHT";
      row.attempts += 1;
    }
    void worker;
    return due.map((row) => ({ ...row }));
  }

  async markForwarded(outboxId: string): Promise<void> {
    const row = [...this.outboxByStatement.values()].find((candidate) => candidate.outbox_id === outboxId);
    if (!row) return;
    row.status = "FORWARDED";
    row.forwarded_at = new Date().toISOString();
    row.last_error = null;
  }

  async markDeliveryFailed(outboxId: string, error: string, nextAttemptAt: Date, deadLetter: boolean): Promise<void> {
    const row = [...this.outboxByStatement.values()].find((candidate) => candidate.outbox_id === outboxId);
    if (!row) return;
    row.status = deadLetter ? "DEAD_LETTER" : "FAILED";
    row.last_error = error.slice(0, 2000);
    row.next_attempt_at = nextAttemptAt.toISOString();
    if (deadLetter) row.dead_lettered_at = new Date().toISOString();
  }

  async statementsForObject(objectId: string, since?: string): Promise<OutboxRow[]> {
    const target = objectId.toLowerCase();
    return [...this.outboxByStatement.values()]
      .filter((row) => row.object_id?.toLowerCase() === target)
      .filter((row) => !since || row.created_at >= since)
      .map((row) => ({ ...row }));
  }

  async recordAssignment(assignment: Assignment): Promise<void> {
    this.assignments.set(assignment.assignment_id, { ...assignment, pseudonyms: [...assignment.pseudonyms] });
  }

  async assignmentsForObject(objectId: string): Promise<Assignment[]> {
    const target = objectId.toLowerCase();
    return [...this.assignments.values()]
      .filter((assignment) => assignment.object_id.toLowerCase() === target)
      .map((assignment) => ({ ...assignment, pseudonyms: [...assignment.pseudonyms] }));
  }

  async createSmartLink(link: SmartLink & { token_hash: string }): Promise<void> {
    this.smartLinksByHash.set(link.token_hash, { ...link });
  }

  async smartLinkByTokenHash(tokenHash: string): Promise<SmartLink | undefined> {
    const link = this.smartLinksByHash.get(tokenHash);
    return link && !link.revoked_at ? { ...link } : undefined;
  }

  async activeSmartLinkForObject(objectId: string): Promise<SmartLink | undefined> {
    const link = [...this.smartLinksByHash.values()].find((candidate) => candidate.object_id === objectId && !candidate.revoked_at);
    return link ? { ...link } : undefined;
  }

  async revokeSmartLink(objectId: string, revokedByPseudonym: string): Promise<SmartLink | undefined> {
    const link = [...this.smartLinksByHash.values()].find((candidate) => candidate.object_id === objectId && !candidate.revoked_at);
    if (!link) return undefined;
    link.revoked_at = new Date().toISOString();
    (link as SmartLink & { revoked_by_pseudonym?: string }).revoked_by_pseudonym = revokedByPseudonym;
    return { ...link };
  }

  async recordSmartLinkRedemption(smartLinkId: string): Promise<void> {
    const link = [...this.smartLinksByHash.values()].find((candidate) => candidate.smart_link_id === smartLinkId);
    if (!link) return;
    link.last_redeemed_at = new Date().toISOString();
    link.redemption_count += 1;
  }

  async recordHeartbeat(worker: string, instance: string, detail?: unknown): Promise<void> {
    this.beats.set(worker, { worker, instance, last_seen_at: new Date().toISOString(), detail: detail ?? null });
  }

  async heartbeats(): Promise<{ worker: string; instance: string; last_seen_at: string; detail: unknown }[]> {
    return [...this.beats.values()];
  }
}
