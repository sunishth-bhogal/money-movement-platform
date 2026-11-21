import pg from "pg";

// BIGINT (int8) comes back from pg as a string by default to avoid precision
// loss. Our amounts are cents and stay far below Number.MAX_SAFE_INTEGER
// (~$90 trillion), so we parse them to numbers, but refuse unsafe values.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds safe integer range`);
  return n;
});

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 20) });
}

/** Postgres SQLSTATEs that mean "this transaction lost a race, try again". */
const RETRYABLE = new Set(["40001" /* serialization_failure */, "40P01" /* deadlock_detected */]);

/**
 * Run fn inside BEGIN/COMMIT on a dedicated connection. Retries the whole
 * transaction on serialization failures and deadlocks. That is only safe
 * because fn has no side effects outside the database.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  { maxAttempts = 3 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
