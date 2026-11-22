import type pg from "pg";

/**
 * user            a wallet user's money; never negative
 * system          the platform's own control accounts; may go negative
 * organizer_held  an organizer's proceeds from events that have not happened yet; never negative
 * organizer       an organizer's available balance; negative means they owe us
 */
export type AccountKind = "user" | "system" | "organizer_held" | "organizer";

export interface Account {
  id: string;
  name: string;
  currency: string;
  kind: AccountKind;
  balance_cents: number;
  created_at: Date;
}

export interface LedgerEntry {
  id: number;
  transfer_id: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  created_at: Date;
}

const ACCOUNT_COLUMNS = "id, name, currency, kind, balance_cents, created_at";

export async function createAccount(
  pool: pg.Pool,
  input: { name: string; currency: string; kind?: AccountKind },
): Promise<Account> {
  const { rows } = await pool.query<Account>(
    `INSERT INTO accounts (name, currency, kind) VALUES ($1, $2, $3) RETURNING ${ACCOUNT_COLUMNS}`,
    [input.name, input.currency, input.kind ?? "user"],
  );
  return rows[0];
}

export async function getAccount(pool: pg.Pool, id: string): Promise<Account | undefined> {
  const { rows } = await pool.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0];
}

/** Transaction history for one account, newest first, keyset-paginated by entry id. */
export async function listEntries(
  pool: pg.Pool,
  accountId: string,
  { limit = 50, before }: { limit?: number; before?: number } = {},
): Promise<LedgerEntry[]> {
  const { rows } = await pool.query<LedgerEntry>(
    `SELECT id, transfer_id, account_id, amount_cents, currency, created_at
       FROM ledger_entries
      WHERE account_id = $1 AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC
      LIMIT $3`,
    [accountId, before ?? null, limit],
  );
  return rows;
}

/**
 * Invariant check used by tests and (later) reconciliation: every cached
 * balance equals the sum of its ledger entries, and all entries sum to zero.
 * Returns the list of violations; empty means the books balance.
 */
export async function checkLedgerInvariants(pool: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const drift = await pool.query<{ id: string; balance_cents: number; ledger_sum: number }>(
    `SELECT a.id, a.balance_cents, COALESCE(SUM(e.amount_cents), 0)::bigint AS ledger_sum
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id
     HAVING a.balance_cents <> COALESCE(SUM(e.amount_cents), 0)`,
  );
  for (const r of drift.rows) problems.push(`account ${r.id}: balance ${r.balance_cents} != ledger ${r.ledger_sum}`);

  const total = await pool.query<{ total: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM ledger_entries",
  );
  if (total.rows[0].total !== 0) problems.push(`ledger does not sum to zero: ${total.rows[0].total}`);

  const unbalanced = await pool.query<{ transfer_id: string }>(
    "SELECT transfer_id FROM ledger_entries GROUP BY transfer_id HAVING SUM(amount_cents) <> 0",
  );
  for (const r of unbalanced.rows) problems.push(`transfer ${r.transfer_id} is unbalanced`);

  const negative = await pool.query<{ id: string; kind: string }>(
    "SELECT id, kind FROM accounts WHERE kind IN ('user', 'organizer_held') AND balance_cents < 0",
  );
  for (const r of negative.rows) problems.push(`${r.kind} account ${r.id} is negative`);
  return problems;
}
