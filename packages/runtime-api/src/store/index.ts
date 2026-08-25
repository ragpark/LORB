/**
 * Selects and holds the process-wide runtime store.
 *
 * Postgres whenever DATABASE_URL is configured, in-process otherwise — and configuration refuses to
 * start a production process without a database, so "otherwise" only ever means development or test.
 */
import pg from "pg";
import { MemoryRuntimeStore } from "./memory.js";
import { PostgresRuntimeStore } from "./postgres.js";
import type { RuntimeStore } from "./types.js";

export * from "./types.js";
export { MemoryRuntimeStore } from "./memory.js";
export { PostgresRuntimeStore } from "./postgres.js";
export { isLegalTransition, transition, OPEN_STATUSES, TERMINAL_STATUSES } from "./transitions.js";

let current: RuntimeStore | undefined;
let pool: pg.Pool | undefined;

export interface StoreOptions {
  databaseUrl?: string;
  /** Bounded so a burst of launches cannot exhaust the database's connection slots. */
  maxConnections?: number;
}

export function runtimePool(databaseUrl: string, maxConnections = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10)): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // Railway and most managed providers terminate TLS with a certificate the container does not
      // chain to. Opt out only when the operator says so, never silently.
      ...(process.env.DATABASE_SSL === "no-verify" ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    // A pool that emits an unhandled 'error' takes the process down. Idle-client errors are normal
    // when a database restarts; the pool replaces the client on the next checkout.
    pool.on("error", () => undefined);
  }
  return pool;
}

export function createStore(options: StoreOptions = {}): RuntimeStore {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  return databaseUrl
    ? new PostgresRuntimeStore(runtimePool(databaseUrl, options.maxConnections))
    : new MemoryRuntimeStore();
}

/** The store this process uses. Created on first use from the environment. */
export function store(): RuntimeStore {
  if (!current) current = createStore();
  return current;
}

/** Installs a store explicitly, for the composition root and for tests. */
export function useStore(next: RuntimeStore): void {
  current = next;
}

/** Test seam: drops back to a clean in-memory store. */
export function resetStore(): RuntimeStore {
  const next = new MemoryRuntimeStore();
  current = next;
  return next;
}

export async function closeStore(): Promise<void> {
  await current?.close().catch(() => undefined);
  current = undefined;
  pool = undefined;
}
