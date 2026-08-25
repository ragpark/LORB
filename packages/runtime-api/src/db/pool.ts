// Administration and roster database access.
import pg from "pg";

let pool: pg.Pool | undefined;

export function adminDbPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for the Administration workspace.");
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export async function withAdminTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await adminDbPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
