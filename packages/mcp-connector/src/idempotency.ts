// In-memory idempotency store for the agent-facing `assign_quiz` tool.
//
// This is the *outermost* of three independent layers, each guarding a different hop, and it replaces
// none of them:
//   1. here          — an agent (or a retrying MCP host) calling assign_quiz twice
//   2. Runtime API   — the Idempotency-Key required on every launch / internal batch request
//   3. Evidence API  — statement UUID deduplication in the outbox
//
// Process-local and unbounded-by-restart, exactly like the rest of the MVP store (see the README's
// caveat that restarts lose state). No new infrastructure is introduced for this PoC.
export interface IdempotencyRecord<T> {
  value: T;
  created_at: string;
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, IdempotencyRecord<T>>();

  constructor(private readonly maxEntries = 1000) {}

  get(key: string): IdempotencyRecord<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): IdempotencyRecord<T> {
    // Bounded so a long-lived PoC process cannot grow without limit; oldest insertion evicted first.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const record = { value, created_at: new Date().toISOString() };
    this.entries.set(key, record);
    return record;
  }

  get size(): number {
    return this.entries.size;
  }
}
