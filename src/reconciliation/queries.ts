import type pg from "pg";
import { discrepancyFingerprint } from "./resolve.js";

/** Read models for the admin dashboard. Nothing here writes. */

export async function controlBalances(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string; name: string; system_code: string; currency: string; balance_cents: number }>(
    `SELECT id, name, system_code, currency, balance_cents FROM accounts
      WHERE system_code IN ('payouts_in_flight', 'bank_payouts', 'stripe_clearing', 'reconciliation_adjustments')
      ORDER BY currency, system_code`,
  );
  return rows;
}

/** The latest completed run per source and currency, and anything newer that is running or failed. */
export async function latestRuns(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (source, currency) id, source, currency, status, open_breaks, auto_resolved, in_transit, matched,
            totals, error, started_at, finished_at
       FROM reconciliation_runs
      ORDER BY source, currency, started_at DESC`,
  );
  return rows;
}

/**
 * Breaks from the latest completed run of each source and currency, with
 * their resolution if a person has decided. `open` excludes resolved ones.
 */
export async function listBreaks(pool: pg.Pool, { includeResolved = false } = {}) {
  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (source, currency) id, source
         FROM reconciliation_runs WHERE status = 'completed'
        ORDER BY source, currency, started_at DESC
     )
     SELECT i.*, l.source,
            CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
              'id', r.id, 'action', r.action, 'counterparty', r.counterparty, 'cause', r.cause, 'note', r.note,
              'resolved_by', r.resolved_by, 'created_at', r.created_at) END AS resolution
       FROM reconciliation_items i
       JOIN latest l ON l.id = i.run_id
       LEFT JOIN reconciliation_resolutions r ON r.item_id = i.id
      WHERE i.outcome IN ('open', 'in_transit') AND ($1 OR r.id IS NULL)
      ORDER BY i.outcome, i.created_at`,
    [includeResolved],
  );
  return rows;
}

export async function runItems(pool: pg.Pool, runId: string) {
  const { rows } = await pool.query(
    `SELECT i.*, (SELECT row_to_json(x) FROM (SELECT r.id, r.action, r.counterparty, r.note, r.resolved_by, r.created_at) x) AS resolution
       FROM reconciliation_items i LEFT JOIN reconciliation_resolutions r ON r.item_id = i.id
      WHERE i.run_id = $1 ORDER BY i.outcome, i.break_key`,
    [runId],
  );
  return rows;
}

/** Payouts the bank contradicted (stage 4 flags them), and whether a person has looked at the current note. */
export async function flaggedPayouts(pool: pg.Pool) {
  const { rows } = await pool.query<{
    id: string;
    account_id: string;
    amount_cents: number;
    currency: string;
    status: string;
    provider_payout_id: string | null;
    discrepancy: string;
    updated_at: Date;
  }>(
    `SELECT id, account_id, amount_cents, currency, status, provider_payout_id, discrepancy, updated_at
       FROM payouts WHERE discrepancy IS NOT NULL ORDER BY updated_at DESC`,
  );
  const { rows: acks } = await pool.query<{ payout_id: string; fingerprint: string; note: string; resolved_by: string; created_at: Date }>(
    `SELECT payout_id, fingerprint, note, resolved_by, created_at FROM reconciliation_resolutions
      WHERE action = 'acknowledge_flag' AND payout_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return rows.map((p) => {
    const ack = acks.find((a) => a.payout_id === p.id && a.fingerprint === discrepancyFingerprint(p.discrepancy));
    return { ...p, acknowledged: ack ?? null };
  });
}

/** Payouts still holding money after `olderThanMs`: safe, but someone should know. */
export async function stuckPayouts(pool: pg.Pool, olderThanMs = 60 * 60_000) {
  const { rows } = await pool.query(
    `SELECT id, account_id, amount_cents, currency, status, provider_payout_id, created_at, updated_at
       FROM payouts
      WHERE status IN ('pending', 'submitted') AND created_at <= now() - make_interval(secs => $1::double precision / 1000)
      ORDER BY created_at`,
    [olderThanMs],
  );
  return rows;
}

export async function deadEvents(pool: pg.Pool, limit = 100) {
  const { rows } = await pool.query(
    `SELECT event_id, event_type, aggregate_type, aggregate_id, attempts, last_error, created_at
       FROM outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * "Where did this money go?" for one item: every ledger transfer that belongs
 * to it, with its entries and account names, every run that looked at it,
 * and every decision about it.
 */
export async function traceBreakKey(pool: pg.Pool, breakKey: string) {
  const [prefix, id] = breakKey.split(":");
  const { rows: transfers } = await pool.query(
    `SELECT t.id, t.idempotency_key, t.status, t.amount_cents, t.currency, t.created_at,
            json_agg(json_build_object('account_id', e.account_id, 'account', a.name, 'amount_cents', e.amount_cents) ORDER BY e.id) AS entries
       FROM transfers t
       JOIN ledger_entries e ON e.transfer_id = t.id
       JOIN accounts a ON a.id = e.account_id
      WHERE (t.idempotency_scope = 'system' AND $1 IN ('payout', 'deposit', 'order') AND split_part(t.idempotency_key, ':', 1) = $1
             AND split_part(t.idempotency_key, ':', 2) = $2)
         OR t.id IN (SELECT p.transfer_id FROM reconciliation_resolution_postings p
                       JOIN reconciliation_resolutions r ON r.id = p.resolution_id WHERE r.break_key = $3)
      GROUP BY t.id
      ORDER BY t.created_at, t.id`,
    [prefix, id ?? "", breakKey],
  );
  const { rows: items } = await pool.query(
    `SELECT i.id, i.run_id, i.classification, i.outcome, i.detail, i.auto_action, i.created_at
       FROM reconciliation_items i WHERE i.break_key = $1 ORDER BY i.created_at`,
    [breakKey],
  );
  const { rows: resolutions } = await pool.query(
    `SELECT id, item_id, action, counterparty, note, resolved_by, created_at
       FROM reconciliation_resolutions WHERE break_key = $1 ORDER BY created_at`,
    [breakKey],
  );
  return { break_key: breakKey, transfers, items, resolutions };
}
