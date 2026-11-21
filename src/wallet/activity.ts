import type pg from "pg";

/**
 * What a user sees of their own money: balances, an activity feed, and a
 * ledger statement. Read-only queries over the same tables everything else
 * writes; nothing here has its own state.
 *
 * The feed shows one row per thing the user did or received, not one row per
 * ledger posting. A payout is one row even though it may post a hold and a
 * reversal, and that row's `state` follows the payout:
 *
 *   pending   the money is on its way (a payout held but not paid out, a
 *             deposit waiting for Stripe to collect it)
 *   settled   it happened (a posted transfer, a credited deposit, a payout the bank paid)
 *   failed    it did not, or it came back (a rejected transfer, an expired or
 *             failed deposit, a payout the bank failed or returned)
 *
 * `balance_effect_cents` is what the row does to the balance right now. A
 * failed payout is 0 because its hold was reversed. The statement shows every
 * posting behind it.
 */
export type ActivityState = "pending" | "settled" | "failed";
export type ActivityKind = "deposit" | "payout" | "transfer_in" | "transfer_out" | "adjustment";

export interface ActivityItem {
  /** `<kind>:<object id>`, unique within one user's feed. */
  id: string;
  kind: ActivityKind;
  object_id: string;
  title: string;
  state: ActivityState;
  /** The object's own status (e.g. a payout's `submitted`), for detail views. */
  status: string;
  status_label: string;
  amount_cents: number;
  balance_effect_cents: number;
  currency: string;
  counterparty: { id: string; name: string } | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Balances {
  account: { id: string; name: string; currency: string };
  /** The ledger balance: what can be spent or withdrawn now. Held payouts are already out of it. */
  available_cents: number;
  /** Payouts held and on their way to the bank. */
  on_hold_cents: number;
  /** Deposits waiting for Stripe to collect them. Not spendable until they settle. */
  incoming_cents: number;
}

export interface StatementLine {
  entry_id: number;
  transfer_id: string;
  description: string;
  /** The feed row this posting belongs to. */
  activity_id: string;
  amount_cents: number;
  balance_after_cents: number;
  currency: string;
  created_at: string;
}

interface Row {
  kind: ActivityKind;
  object_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  idempotency_key: string | null;
  direction: number;
  counterparty_id: string | null;
  counterparty_name: string | null;
  bank_last4: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_us: string;
}

// One row per feed item, newest first. Keyset-paginated on (created_at in
// microseconds, object id), so items created in the same millisecond are
// neither skipped nor repeated between pages.
const FEED_SQL = `
  WITH items AS (
    SELECT 'deposit' AS kind, d.id AS object_id, d.amount_cents, d.currency, d.status, d.failure_reason,
           NULL::text AS idempotency_key, 1 AS direction, NULL::uuid AS counterparty_id, NULL::text AS counterparty_name,
           NULL::text AS bank_last4, d.created_at, d.updated_at
      FROM deposits d
     WHERE d.account_id = $1
    UNION ALL
    SELECT 'payout', p.id, p.amount_cents, p.currency, p.status, p.failure_reason,
           NULL, -1, NULL, NULL, right(p.bank_account_number, 4), p.created_at, p.updated_at
      FROM payouts p
     WHERE p.account_id = $1
    UNION ALL
    -- Transfers clients asked for. A rejected one is only shown to its sender.
    SELECT CASE WHEN t.from_account_id = $1 THEN 'transfer_out' ELSE 'transfer_in' END, t.id, t.amount_cents, t.currency,
           t.status, t.failure_reason, NULL, CASE WHEN t.from_account_id = $1 THEN -1 ELSE 1 END,
           o.id, o.name, NULL, t.created_at, t.created_at
      FROM transfers t
      JOIN accounts o ON o.id = CASE WHEN t.from_account_id = $1 THEN t.to_account_id ELSE t.from_account_id END
     WHERE t.idempotency_scope = 'api'
       AND (t.from_account_id = $1 OR (t.to_account_id = $1 AND t.status = 'posted'))
    UNION ALL
    -- Postings our own code made that are not part of a deposit or payout
    -- (those are shown as their deposit or payout): funding, reconciliation corrections.
    SELECT 'adjustment', t.id, t.amount_cents, t.currency, t.status, NULL, t.idempotency_key,
           CASE WHEN t.from_account_id = $1 THEN -1 ELSE 1 END, o.id, o.name, NULL, t.created_at, t.created_at
      FROM transfers t
      JOIN accounts o ON o.id = CASE WHEN t.from_account_id = $1 THEN t.to_account_id ELSE t.from_account_id END
     WHERE t.idempotency_scope = 'system' AND t.status = 'posted'
       AND (t.from_account_id = $1 OR t.to_account_id = $1)
       AND t.idempotency_key NOT LIKE 'deposit:%' AND t.idempotency_key NOT LIKE 'payout:%'
  )
  SELECT *, (extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_us
    FROM items
   WHERE ($2::bigint IS NULL OR ((extract(epoch FROM created_at) * 1000000)::bigint, object_id) < ($2::bigint, $3::uuid))
     AND ($4::uuid IS NULL OR object_id = $4::uuid)
   ORDER BY created_at DESC, object_id DESC
   LIMIT $5`;

const DEPOSIT_LABELS: Record<string, [ActivityState, string]> = {
  created: ["pending", "Waiting for payment"],
  pending: ["pending", "Waiting for payment"],
  processing: ["pending", "Payment processing"],
  requires_review: ["pending", "Under review"],
  succeeded: ["settled", "Completed"],
  failed: ["failed", "Payment failed"],
  expired: ["failed", "Checkout abandoned"],
};

const PAYOUT_LABELS: Record<string, [ActivityState, string]> = {
  pending: ["pending", "Sending to bank"],
  submitted: ["pending", "Bank is processing"],
  succeeded: ["settled", "Paid out"],
  failed: ["failed", "Bank failed it, refunded"],
  returned: ["failed", "Returned by bank, refunded"],
  rejected: ["failed", "Not enough money"],
};

function toItem(r: Row): ActivityItem {
  let state: ActivityState;
  let label: string;
  let title: string;
  let effect = 0;
  switch (r.kind) {
    case "deposit":
      [state, label] = DEPOSIT_LABELS[r.status] ?? ["pending", r.status];
      title = "Added funds";
      if (r.status === "succeeded") effect = r.amount_cents;
      break;
    case "payout":
      [state, label] = PAYOUT_LABELS[r.status] ?? ["pending", r.status];
      title = `Withdrawal to bank ••${r.bank_last4}`;
      // Held from the moment it is accepted, until the bank fails or returns it.
      if (["pending", "submitted", "succeeded"].includes(r.status)) effect = -r.amount_cents;
      break;
    case "transfer_in":
    case "transfer_out": {
      const posted = r.status === "posted";
      state = posted ? "settled" : "failed";
      label = posted ? "Completed" : r.failure_reason === "insufficient_funds" ? "Not enough money" : "Rejected";
      title = r.kind === "transfer_out" ? `Sent to ${r.counterparty_name}` : `Received from ${r.counterparty_name}`;
      if (posted) effect = r.direction * r.amount_cents;
      break;
    }
    case "adjustment":
      state = "settled";
      label = "Completed";
      title = r.idempotency_key?.startsWith("recon:") ? "Reconciliation correction" : "Account funding";
      effect = r.direction * r.amount_cents;
      break;
  }
  const isPeer = r.kind === "transfer_in" || r.kind === "transfer_out";
  return {
    id: `${r.kind}:${r.object_id}`,
    kind: r.kind,
    object_id: r.object_id,
    title,
    state,
    status: r.status,
    status_label: label,
    amount_cents: r.amount_cents,
    balance_effect_cents: effect,
    currency: r.currency,
    counterparty: isPeer && r.counterparty_id ? { id: r.counterparty_id, name: r.counterparty_name ?? "" } : null,
    failure_reason: r.failure_reason,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function parseCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const m = /^(\d{1,20})_([0-9a-f-]{36})$/i.exec(cursor);
  return m ? [m[1], m[2]] : null;
}

export async function listActivity(
  pool: pg.Pool,
  accountId: string,
  { limit = 50, before }: { limit?: number; before?: string } = {},
): Promise<{ data: ActivityItem[]; next_cursor: string | null }> {
  const cursor = parseCursor(before);
  const { rows } = await pool.query<Row>(FEED_SQL, [accountId, cursor?.[0] ?? null, cursor?.[1] ?? null, null, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toItem),
    next_cursor: rows.length > limit && last ? `${last.cursor_us}_${last.object_id}` : null,
  };
}

/** One feed row by its object, or undefined if it is not in this user's feed. */
export async function getActivityItem(
  pool: pg.Pool,
  accountId: string,
  kind: ActivityKind,
  objectId: string,
): Promise<ActivityItem | undefined> {
  const { rows } = await pool.query<Row>(FEED_SQL, [accountId, null, null, objectId, 10]);
  const row = rows.find((r) => r.kind === kind);
  return row && toItem(row);
}

export function isValidCursor(cursor: string): boolean {
  return parseCursor(cursor) !== null;
}

export async function getBalances(pool: pg.Pool, accountId: string): Promise<Balances | undefined> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    currency: string;
    balance_cents: number;
    on_hold_cents: number;
    incoming_cents: number;
  }>(
    `SELECT a.id, a.name, a.currency, a.balance_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts
              WHERE account_id = a.id AND status IN ('pending', 'submitted'))::bigint AS on_hold_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM deposits
              WHERE account_id = a.id AND status IN ('pending', 'processing'))::bigint AS incoming_cents
       FROM accounts a
      WHERE a.id = $1 AND a.kind = 'user'`,
    [accountId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    account: { id: r.id, name: r.name, currency: r.currency },
    available_cents: r.balance_cents,
    on_hold_cents: r.on_hold_cents,
    incoming_cents: r.incoming_cents,
  };
}

function describePosting(
  scope: string,
  key: string,
  incoming: boolean,
  counterparty: string | null,
  transferId: string,
): { description: string; activity_id: string } {
  const payout = /^payout:([0-9a-f-]{36}):(\w+)$/.exec(key);
  if (scope === "system" && payout) {
    const [, id, step] = payout;
    const description =
      step === "hold"
        ? "Withdrawal: money held for the bank"
        : step === "reverse"
          ? "Withdrawal failed: hold released"
          : step === "return"
            ? "Withdrawal returned by the bank"
            : `Withdrawal (${step})`;
    return { description, activity_id: `payout:${id}` };
  }
  const deposit = /^deposit:([0-9a-f-]{36})$/.exec(key);
  if (scope === "system" && deposit) return { description: "Deposit collected by Stripe", activity_id: `deposit:${deposit[1]}` };
  if (scope === "api") {
    return {
      description: incoming ? `Received from ${counterparty}` : `Sent to ${counterparty}`,
      activity_id: `${incoming ? "transfer_in" : "transfer_out"}:${transferId}`,
    };
  }
  return {
    description: key.startsWith("recon:") ? "Reconciliation correction" : "Account funding",
    activity_id: `adjustment:${transferId}`,
  };
}

/** Every ledger posting on the account, newest first, with the balance after each one. */
export async function listStatement(
  pool: pg.Pool,
  accountId: string,
  { limit = 100, before }: { limit?: number; before?: number } = {},
): Promise<{ data: StatementLine[]; next_before: number | null }> {
  const { rows } = await pool.query<{
    id: number;
    transfer_id: string;
    amount_cents: number;
    currency: string;
    created_at: Date;
    idempotency_scope: string;
    idempotency_key: string;
    counterparty: string | null;
    balance_after: number;
  }>(
    `SELECT * FROM (
       SELECT e.id, e.transfer_id, e.amount_cents, e.currency, e.created_at, t.idempotency_scope, t.idempotency_key,
              o.name AS counterparty,
              (SUM(e.amount_cents) OVER (ORDER BY e.id))::bigint AS balance_after
         FROM ledger_entries e
         JOIN transfers t ON t.id = e.transfer_id
         LEFT JOIN accounts o ON o.id = CASE WHEN t.from_account_id = e.account_id THEN t.to_account_id ELSE t.from_account_id END
        WHERE e.account_id = $1
     ) s
     WHERE $2::bigint IS NULL OR s.id < $2
     ORDER BY s.id DESC
     LIMIT $3`,
    [accountId, before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    data: page.map((r) => ({
      entry_id: r.id,
      transfer_id: r.transfer_id,
      ...describePosting(r.idempotency_scope, r.idempotency_key, r.amount_cents > 0, r.counterparty, r.transfer_id),
      amount_cents: r.amount_cents,
      balance_after_cents: r.balance_after,
      currency: r.currency,
      created_at: r.created_at.toISOString(),
    })),
    next_before: rows.length > limit ? page[page.length - 1].id : null,
  };
}
