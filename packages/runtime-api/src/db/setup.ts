import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.log("DATABASE_URL is not set; skipping database migrations and seed data.");
  process.exit(0);
}

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(directory, "migrations");
const seedFile = join(directory, "seed.sql");
const client = new pg.Client({ connectionString });

await client.connect();
try {
  await client.query("select pg_advisory_lock($1)", [20260813]);
  await client.query(`create table if not exists schema_migration (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`);

  for (const filename of (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
    const applied = await client.query("select 1 from schema_migration where filename = $1", [filename]);
    if (applied.rowCount) continue;
    await client.query("begin");
    try {
      await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
      await client.query("insert into schema_migration(filename) values ($1)", [filename]);
      await client.query("commit");
      console.log(`Applied migration ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  await client.query(await readFile(seedFile, "utf8"));
  console.log("Database setup complete.");
} finally {
  await client.query("select pg_advisory_unlock($1)", [20260813]).catch(() => undefined);
  await client.end();
}
