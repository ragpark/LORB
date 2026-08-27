/**
 * Runs the learning record store.
 *
 * Migrations are applied at start-up rather than in a separate step: the service owns its schema, and
 * a deployment that has to remember to run a command before the container starts is a deployment
 * that will one day forget.
 */
import "dotenv/config";
import { buildLrs } from "./app.js";
import { loadLrsConfig } from "./config.js";
import { lrsPool, migrate } from "./db.js";
import { MemoryLrsStore, PostgresLrsStore, type LrsStore } from "./store.js";

/**
 * A configuration failure exits 78 (EX_CONFIG) with the problems named, as every other service here
 * does: an operator reading the deploy log should see what is missing, not a stack trace.
 */
let config;
try {
  config = loadLrsConfig();
} catch {
  process.exit(78);
}

let store: LrsStore;
if (config.databaseUrl) {
  const pool = lrsPool(config.databaseUrl);
  const applied = await migrate(pool);
  process.stdout.write(JSON.stringify({ service: "lorb-lrs", msg: applied === 0 ? "database is up to date" : `applied ${applied} migration(s)` }) + "\n");
  store = new PostgresLrsStore(pool);
} else {
  process.stdout.write(JSON.stringify({ service: "lorb-lrs", msg: "no database configured: statements are held in memory and lost on restart" }) + "\n");
  store = new MemoryLrsStore();
}

const { app } = await buildLrs({ config, store });
await app.listen({ host: "0.0.0.0", port: config.port });
process.stdout.write(JSON.stringify({
  service: "lorb-lrs",
  environment: config.environment,
  msg: `listening on ${config.port}`,
  persistence: store.kind,
  credentials: config.credentials.length,
}) + "\n");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.close().then(() => store.close()).finally(() => process.exit(0));
  });
}
