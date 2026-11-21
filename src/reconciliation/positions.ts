import { createHash } from "node:crypto";
import type pg from "pg";

/** Whose records a run compares the ledger with. */
export type ReconSource = "mock_bank" | "stripe";

export const RECON_SOURCES: readonly ReconSource[] = ["mock_bank", "stripe"];

/**
 * What one side says about one item's money, in cents.
 *   held     on its way out: "Payouts in flight", or the bank's `processing`
 *   settled  gone: "Bank payouts", or the bank's `succeeded`; for Stripe,
 *            money collected and credited to a user
 */
export interface Position {
  held: number;
  settled: number;
}

export const ZERO: Position = { held: 0, settled: 0 };

export const samePosition = (a: Position, b: Position) => a.held === b.held && a.settled === b.settled;

/**
 * The ledger's control accounts for a source: where its money sits in our
 * books. `sign` turns an account's net entries into a position (Stripe
 * clearing goes negative by the amount Stripe has collected for us).
 */
export interface ControlDimension {
  dimension: keyof Position;
  systemCode: string;
  name: string;
  sign: 1 | -1;
}

export const CONTROL: Record<ReconSource, ControlDimension[]> = {
  mock_bank: [
    { dimension: "held", systemCode: "payouts_in_flight", name: "Payouts in flight", sign: 1 },
    { dimension: "settled", systemCode: "bank_payouts", name: "Bank payouts", sign: 1 },
  ],
  stripe: [{ dimension: "settled", systemCode: "stripe_clearing", name: "Stripe clearing", sign: -1 }],
};

/** The system-scoped transfer keys that belong to a source's items: payout:<id>:<step>, deposit:<id>. */
const KEY_PREFIX: Record<ReconSource, string> = { mock_bank: "payout", stripe: "deposit" };

/** The key a payout or deposit is known by in reconciliation, across runs. */
export const objectBreakKey = (source: ReconSource, id: string) => `${KEY_PREFIX[source]}:${id}`;

/**
 * Where every cent on a source's control accounts came from, grouped by item.
 *
 * A ledger transfer belongs to an item if its key says so (payout:<id>:hold,
 * payout:<id>:settle, deposit:<id>, ...) or if a reconciliation resolution for
 * that item posted it. Anything on a control account that belongs to no item
 * is reported as unattributed: it is money the books cannot explain, and a
 * clean run requires it to be zero.
 *
 * `onlyKey` narrows it to one item (used under that item's lock).
 */
export async function ledgerPositions(
  db: pg.Pool | pg.PoolClient,
  source: ReconSource,
  currency: string,
  onlyKey?: string,
): Promise<{ byKey: Map<string, Position>; balances: Position; unattributed: Position }> {
  const dims = CONTROL[source];
  const codes = dims.map((d) => d.systemCode);
  const prefix = KEY_PREFIX[source];
  const { rows } = await db.query<{ break_key: string; system_code: string; net: number }>(
    `WITH ctl AS (
       SELECT id, system_code FROM accounts WHERE currency = $1 AND system_code = ANY($2::text[])
     ), attributed AS (
       SELECT t.id AS transfer_id, $3 || ':' || split_part(t.idempotency_key, ':', 2) AS break_key
         FROM transfers t
        WHERE t.idempotency_scope = 'system' AND t.idempotency_key LIKE $3 || ':%' AND t.currency = $1
       UNION ALL
       SELECT p.transfer_id, r.break_key
         FROM reconciliation_resolution_postings p
         JOIN reconciliation_resolutions r ON r.id = p.resolution_id
     )
     SELECT a.break_key, c.system_code, SUM(e.amount_cents)::bigint AS net
       FROM ledger_entries e
       JOIN ctl c ON c.id = e.account_id
       JOIN attributed a ON a.transfer_id = e.transfer_id
      WHERE ($4::text IS NULL OR a.break_key = $4)
      GROUP BY 1, 2`,
    [currency, codes, prefix, onlyKey ?? null],
  );
  const byKey = new Map<string, Position>();
  const attributedTotal: Position = { ...ZERO };
  for (const r of rows) {
    const dim = dims.find((d) => d.systemCode === r.system_code)!;
    const pos = byKey.get(r.break_key) ?? { ...ZERO };
    pos[dim.dimension] += dim.sign * r.net;
    attributedTotal[dim.dimension] += dim.sign * r.net;
    byKey.set(r.break_key, pos);
  }
  const { rows: accounts } = await db.query<{ system_code: string; balance_cents: number }>(
    "SELECT system_code, balance_cents FROM accounts WHERE currency = $1 AND system_code = ANY($2::text[])",
    [currency, codes],
  );
  const balances: Position = { ...ZERO };
  for (const a of accounts) {
    const dim = dims.find((d) => d.systemCode === a.system_code)!;
    balances[dim.dimension] += dim.sign * a.balance_cents;
  }
  return {
    byKey,
    balances,
    unattributed: onlyKey
      ? { ...ZERO }
      : { held: balances.held - attributedTotal.held, settled: balances.settled - attributedTotal.settled },
  };
}

export type Classification = "missing_at_provider" | "missing_in_ledger" | "amount_mismatch" | "status_mismatch";

export interface Disagreement {
  classification: Classification;
  our_status: string | null;
  provider_status: string | null;
  our_amount_cents: number | null;
  provider_amount_cents: number | null;
  ledger: Position;
  provider: Position;
}

/**
 * Identifies one exact disagreement. A person's resolution settles a
 * fingerprint; if anything about the item changes, it is a new disagreement
 * and comes back to the dashboard.
 */
export function fingerprint(d: Disagreement): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        d.classification,
        d.our_status,
        d.provider_status,
        d.our_amount_cents,
        d.provider_amount_cents,
        d.ledger.held,
        d.ledger.settled,
        d.provider.held,
        d.provider.settled,
      ]),
    )
    .digest("hex");
}

/** Serialise all work on one item: the run's automatic fixes and a person's resolution. */
export async function lockBreakKey(client: pg.PoolClient, breakKey: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('recon:' || $1, 0))", [breakKey]);
}
