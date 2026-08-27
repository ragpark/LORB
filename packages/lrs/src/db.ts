/**
 * The learning record store's database, and the migrations that shape it.
 *
 * Migrations are applied under an advisory lock and recorded by filename, the same way the runtime's
 * are: several replicas starting at once must apply a migration once rather than race to create the
 * same table.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Distinct from the runtime's lock id: the two services may share a database and must not block each other. */
const ADVISORY_LOCK = 20260827;

export function lrsPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: Number.parseInt(process.env.LRS_DATABASE_POOL_MAX ?? "10", 10),
    ...(process.env.LRS_DATABASE_SSL === "no-verify" ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

export async function migrate(pool: pg.Pool): Promise<number> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK]);
    await client.query(`create table if not exists lrs_schema_migration (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
      const already = await client.query("select 1 from lrs_schema_migration where filename = $1", [filename]);
      if (already.rowCount) continue;
      await client.query("begin");
      try {
        await client.query(await readFile(join(directory, filename), "utf8"));
        await client.query("insert into lrs_schema_migration(filename) values ($1)", [filename]);
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}
