/**
 * The evidence forwarder.
 *
 * Reads the durable outbox and delivers each accepted xAPI statement to the configured learning
 * record store. The previous implementation walked an in-memory map once, marked anything that did
 * not return 200 as FAILED, and never looked at it again — so a learning record store that was
 * briefly unreachable silently destroyed the evidence for every attempt in that window.
 *
 * What replaces it:
 *
 *   - Rows are claimed transactionally, so every replica can run a forwarder without any statement
 *     being delivered twice.
 *   - A failure is retried with exponential backoff and jitter, and only becomes a dead letter after
 *     a bounded number of attempts. A dead letter is visible and replayable; it is never discarded.
 *   - 4xx responses other than 408 and 429 are not retried: a statement the learning record store
 *     considers malformed will not become well-formed on the tenth attempt, and retrying it forever
 *     starves the queue behind it.
 *   - Delivery is idempotent at the receiver too, because the statement carries its own UUID and
 *     xAPI treats that as the deduplication key.
 */
import { randomUUID } from "node:crypto";
import type { LrsConfig, ForwarderConfig } from "../../runtime-api/src/config/index.js";
import { store as defaultStore, type OutboxRow, type RuntimeStore } from "../../runtime-api/src/store/index.js";
import { logger, metrics } from "../../runtime-api/src/services/observability.js";

export interface DeliveryResult {
  statusCode: number;
  body?: string;
}

export type StatementSender = (payload: unknown, row: OutboxRow) => Promise<DeliveryResult>;

/**
 * A sender that speaks the xAPI statements resource. The statement id is sent as the `statementId`
 * parameter on a PUT, which is what makes the delivery idempotent at the learning record store: a
 * repeat of the same statement is a no-op there rather than a second record.
 */
export function httpSender(lrs: LrsConfig): StatementSender {
  return async (payload, row) => {
    const url = new URL(`${lrs.endpoint}/statements`);
    url.searchParams.set("statementId", row.statement_id);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-experience-api-version": lrs.xapiVersion,
      "x-correlation-id": row.correlation_id,
    };
    if (lrs.auth.kind === "bearer") headers.authorization = `Bearer ${lrs.auth.token}`;
    if (lrs.auth.kind === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${lrs.auth.username}:${lrs.auth.password}`).toString("base64")}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lrs.timeoutMs);
    try {
      const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify(payload), signal: controller.signal });
      // Bodies are read only to record why a delivery failed, and truncated: a learning record store
      // that echoes the statement back would otherwise put learner content in our error column.
      const body = response.ok ? undefined : (await response.text().catch(() => "")).slice(0, 500);
      return { statusCode: response.status, body };
    } catch (error) {
      // A network failure is not a rejection: 0 marks it retryable below.
      return { statusCode: 0, body: (error as Error).message.slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 2xx and 409 (the receiver already has this statement) both mean the evidence has landed. */
function delivered(statusCode: number): boolean {
  return (statusCode >= 200 && statusCode < 300) || statusCode === 409;
}

/** A 4xx that is not a timeout or a rate limit will not succeed on retry. */
function permanentlyRejected(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

export function backoffMs(attempt: number, forwarder: ForwarderConfig, random: () => number = Math.random): number {
  const exponential = Math.min(forwarder.baseBackoffMs * 2 ** Math.max(0, attempt - 1), forwarder.maxBackoffMs);
  // Full jitter. Without it every replica retries the same batch at the same instant after an
  // outage, which is precisely when the learning record store can least absorb it.
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export interface ForwardOptions {
  store?: RuntimeStore;
  forwarder: ForwarderConfig;
  worker?: string;
  now?: () => Date;
  random?: () => number;
}

export interface ForwardSummary {
  claimed: number;
  forwarded: number;
  retried: number;
  deadLettered: number;
}

/** Runs one pass over the due statements. Returns what happened, for logs and for the tests. */
export async function forwardPending(send: StatementSender, options: ForwardOptions): Promise<ForwardSummary> {
  const store = options.store ?? defaultStore();
  const worker = options.worker ?? `forwarder-${process.pid}`;
  const now = options.now ?? (() => new Date());
  const summary: ForwardSummary = { claimed: 0, forwarded: 0, retried: 0, deadLettered: 0 };

  const claimed = await store.claimDueStatements(worker, options.forwarder.batchSize, now());
  summary.claimed = claimed.length;

  for (const row of claimed) {
    let result: DeliveryResult;
    try {
      result = await send(row.payload, row);
    } catch (error) {
      result = { statusCode: 0, body: (error as Error).message.slice(0, 500) };
    }

    if (delivered(result.statusCode)) {
      await store.markForwarded(row.outbox_id);
      summary.forwarded += 1;
      metrics.evidenceForwarded.inc({ outcome: "delivered" });
      metrics.evidenceLag.observe(Math.max(0, (now().getTime() - new Date(row.created_at).getTime()) / 1000));
      continue;
    }

    const exhausted = row.attempts >= options.forwarder.maxAttempts;
    const permanent = permanentlyRejected(result.statusCode);
    const deadLetter = exhausted || permanent;
    const reason = `${result.statusCode || "network"}: ${result.body ?? "delivery failed"}`;
    await store.markDeliveryFailed(
      row.outbox_id,
      reason,
      new Date(now().getTime() + backoffMs(row.attempts, options.forwarder, options.random)),
      deadLetter,
    );
    if (deadLetter) {
      summary.deadLettered += 1;
      metrics.evidenceForwarded.inc({ outcome: permanent ? "rejected" : "exhausted" });
      logger().error({ outbox_id: row.outbox_id, statement_id: row.statement_id, attempts: row.attempts, status: result.statusCode }, "evidence dead-lettered");
    } else {
      summary.retried += 1;
      metrics.evidenceForwarded.inc({ outcome: "retry" });
    }
  }

  return summary;
}

export interface ForwarderHandle {
  stop: () => Promise<void>;
  /** Runs one pass immediately, for a readiness check or a test. */
  tick: () => Promise<ForwardSummary>;
}

/**
 * Starts the polling loop. Passes never overlap: the next one is scheduled after the current one
 * settles, so a slow learning record store cannot pile concurrent batches on top of each other.
 */
export function startForwarder(send: StatementSender, options: ForwardOptions & { pollIntervalMs?: number }): ForwarderHandle {
  const store = options.store ?? defaultStore();
  const instance = `${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;
  const interval = options.pollIntervalMs ?? options.forwarder.pollIntervalMs;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<ForwardSummary> => {
    const summary = await forwardPending(send, options);
    await store.recordHeartbeat("evidence-forwarder", instance, summary).catch(() => undefined);
    return summary;
  };

  const loop = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (error) {
      logger().error({ err: { message: (error as Error).message } }, "evidence forwarder pass failed");
    }
    if (!stopped) timer = setTimeout(() => void loop(), interval).unref();
  };

  timer = setTimeout(() => void loop(), interval).unref();

  return {
    tick,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
