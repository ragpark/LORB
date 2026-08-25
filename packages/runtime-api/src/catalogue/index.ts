/**
 * Selects and holds the process-wide catalogue store.
 */
import { MemoryCatalogueStore } from "./memory.js";
import { PostgresCatalogueStore } from "./postgres.js";
import { runtimePool } from "../store/index.js";
import type { CatalogueStore } from "./types.js";

export * from "./types.js";
export { MemoryCatalogueStore } from "./memory.js";
export { PostgresCatalogueStore } from "./postgres.js";
export { QUIZ_PLAYER, QUIZ_PLAYER_PACKAGE, DEFAULT_REPOSITORY, EXAMPLE_OBJECTS } from "./shared.js";

let current: CatalogueStore | undefined;

export function createCatalogue(options: { databaseUrl?: string; seedExamples?: boolean } = {}): CatalogueStore {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  return databaseUrl
    ? new PostgresCatalogueStore(runtimePool(databaseUrl))
    : new MemoryCatalogueStore({ seedExamples: options.seedExamples });
}

export function catalogue(): CatalogueStore {
  if (!current) current = createCatalogue();
  return current;
}

export function useCatalogue(next: CatalogueStore): void {
  current = next;
}

/** Test seam: a clean in-memory catalogue carrying the bundled examples. */
export function resetCatalogue(seedExamples = true): CatalogueStore {
  const next = new MemoryCatalogueStore({ seedExamples });
  current = next;
  return next;
}
