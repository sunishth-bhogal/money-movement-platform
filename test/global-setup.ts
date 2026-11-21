import pg from "pg";
import { migrate } from "../src/migrate.js";

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/money_test";

export default async function setup() {
  process.env.DATABASE_URL ??= DEFAULT_URL;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Fresh schema every run. (Can't TRUNCATE ledger_entries: it's append-only.)
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
