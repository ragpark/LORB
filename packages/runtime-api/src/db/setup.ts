/**
 * Applies migrations, and — only where an operator has asked for it — the example content.
 *
 * Two properties matter for running this on every deploy of a multi-replica service:
 *
 *   - An advisory lock, so several replicas starting at once apply a migration once rather than
 *     racing to create the same table.
 *   - Each migration in its own transaction with its filename recorded, so a failure leaves the
 *     database at a known point rather than half-migrated.
 *
 * The example content is not applied unless SEED_EXAMPLE_CONTENT is set, and production
 * configuration refuses that flag outright: a deployed catalogue contains what was registered
 * through the Publisher API and nothing else.
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    console.error("DATABASE_URL is required: a deployed environment cannot run without a database.");
    process.exit(78);
  }
  console.log("DATABASE_URL is not set; skipping migrations.");
  process.exit(0);
}

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(directory, "migrations");
const seedFile = join(directory, "seed.sql");
const client = new pg.Client({ connectionString });

const seedExamples = /^(1|true|yes|on)$/i.test(process.env.SEED_EXAMPLE_CONTENT ?? "");
const production = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";

await client.connect();
try {
  await client.query("select pg_advisory_lock($1)", [20260813]);
  await client.query(`create table if not exists schema_migration (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`);

  let applied = 0;
  for (const filename of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    const already = await client.query("select 1 from schema_migration where filename = $1", [filename]);
    if (already.rowCount) continue;
    await client.query("begin");
    try {
      await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
      await client.query("insert into schema_migration(filename) values ($1)", [filename]);
      await client.query("commit");
      applied += 1;
      console.log(`Applied migration ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  if (seedExamples && production) {
    console.error("SEED_EXAMPLE_CONTENT must not be enabled in production.");
    process.exit(78);
  }
  if (seedExamples) {
    await client.query(await readFile(seedFile, "utf8"));
    console.log("Example content seeded. This is a development convenience.");
  }

  console.log(applied === 0 ? "Database is up to date." : `Database setup complete (${applied} migration(s) applied).`);
} finally {
  await client.query("select pg_advisory_unlock($1)", [20260813]).catch(() => undefined);
  await client.end();
}
