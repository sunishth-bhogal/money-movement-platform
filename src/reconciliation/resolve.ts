import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { createTransferInTx } from "../ledger/transfers.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { stripeClearingAccount } from "../payments/deposits.js";
import { bankPayoutsAccount, inFlightAccount, systemAccount } from "../payouts/payouts.js";
import { CONTROL, ledgerPositions, lockBreakKey, type Position, type ReconSource } from "./positions.js";

export type ResolutionAction = "accept_provider" | "accept_ours";
export type Counterparty = "user" | "platform";

export interface Resolution {
  id: string;
  item_id: string | null;
  payout_id: string | null;
  break_key: string;
  fingerprint: string;
  action: ResolutionAction | "acknowledge_flag";
  counterparty: Counterparty | null;
  note: string;
  resolved_by: string;
  created_at: Date;
  transfer_ids: string[];
}

export interface ResolveRequest {
  action: ResolutionAction;
  /** Required for accept_provider: who gives or receives what is left after moving money between our control accounts. */
  counterparty?: Counterparty;
  note: string;
  resolved_by: string;
}

/** Where the business absorbs a loss or keeps a gain a person decided on. Can go negative. */
export const adjustmentsAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "reconciliation_adjustments", "Reconciliation adjustments", currency);

interface ItemRow {
  id: string;
  run_id: string;
  source: ReconSource;
  break_key: string;
  object_type: "payout" | "deposit";
  object_id: string | null;
  account_id: string | null;
  outcome: string;
  currency: string;
  ledger_held_cents: number;
  ledger_settled_cents: number;
  provider_held_cents: number;
  provider_settled_cents: number;
  fingerprint: string;
}

const RESOLUTION_COLUMNS =
  "r.id, r.item_id, r.payout_id, r.break_key, r.fingerprint, r.action, r.counterparty, r.note, r.resolved_by, r.created_at, " +
  "COALESCE((SELECT array_agg(p.transfer_id::text ORDER BY t.created_at, t.id) FROM reconciliation_resolution_postings p " +
  "JOIN transfers t ON t.id = p.transfer_id WHERE p.resolution_id = r.id), '{}') AS transfer_ids";

/** One planned ledger transfer. */
interface Leg {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that move the ledger from `ledger` to `provider` for one item.
 *
 * First, money that is merely in the wrong one of our own control accounts
 * moves between them (e.g. still "in flight" when the bank says it was paid
 * out). Whatever difference is left comes from, or goes to, the counterparty:
 * the user (their money never left, so it goes back to them; or it did leave,
 * so it is taken from their balance), or the platform's adjustments account
 * (the business absorbs the loss or keeps the gain).
 */
async function plan(
  c: pg.PoolClient,
  source: ReconSource,
  currency: string,
  ledger: Position,
  provider: Position,
  counterpartyId: string,
): Promise<Leg[]> {
  const accountFor = async (systemCode: string) =>
    systemCode === "payouts_in_flight"
      ? inFlightAccount(c, currency)
      : systemCode === "bank_payouts"
        ? bankPayoutsAccount(c, currency)
        : stripeClearingAccount(c, currency);
  const dims = CONTROL[source];
  const delta: Position = { held: provider.held - ledger.held, settled: provider.settled - ledger.settled };
  const legs: Leg[] = [];

  if (source === "mock_bank") {
    const inFlight = await accountFor("payouts_in_flight");
    const paidOut = await accountFor("bank_payouts");
    if (delta.held < 0 && delta.settled > 0) {
      const m = Math.min(-delta.held, delta.settled);
      legs.push({ from: inFlight, to: paidOut, amount: m });
      delta.held += m;
      delta.settled -= m;
    } else if (delta.held > 0 && delta.settled < 0) {
      const m = Math.min(delta.held, -delta.settled);
      legs.push({ from: paidOut, to: inFlight, amount: m });
      delta.held -= m;
      delta.settled += m;
    }
  }
  for (const dim of dims) {
    const d = delta[dim.dimension];
    if (d === 0) continue;
    const account = await accountFor(dim.systemCode);
    // Raising a position by d means the account's net must change by sign × d.
    if (dim.sign * d > 0) legs.push({ from: counterpartyId, to: account, amount: Math.abs(d) });
    else legs.push({ from: account, to: counterpartyId, amount: Math.abs(d) });
  }
  return legs;
}

/**
 * Record a person's decision about an open break, and post the money it moves.
 *
 * ONE transaction, and safe to retry or double-click:
 *  - Only an open item from the latest completed run of its source and
 *    currency can be resolved. An older run's view may be out of date.
 *  - The item's lock (shared with the run's own fixes) and its payout or
 *    deposit row lock (shared with webhooks) are taken first, then the
 *    ledger is read again. If the item's money has moved since the run
 *    looked, the request is refused: re-run reconciliation and decide on
 *    what is true now. This is what stops a correction being applied on top
 *    of a webhook that already fixed it.
 *  - One resolution per item (a unique constraint). The same request again
 *    returns the stored resolution; a different one gets 409.
 *  - accept_provider posts new, system-scoped transfers keyed
 *    recon:<resolution id>:<n>, linked to the resolution. Nothing is edited.
 */
export async function resolveItem(
  pool: pg.Pool,
  itemId: string,
  req: ResolveRequest,
): Promise<{ resolution: Resolution; replayed: boolean }> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<ItemRow>(
      `SELECT i.id, i.run_id, r.source, i.break_key, i.object_type, i.object_id, i.account_id, i.outcome, i.currency,
              i.ledger_held_cents, i.ledger_settled_cents, i.provider_held_cents, i.provider_settled_cents, i.fingerprint
         FROM reconciliation_items i JOIN reconciliation_runs r ON r.id = i.run_id
        WHERE i.id = $1`,
      [itemId],
    );
    const it = rows[0];
    if (!it) throw new ApiError(404, "item_not_found", "Reconciliation item not found.");
    await lockBreakKey(c, it.break_key);

    const existing = await findResolution(c, "r.item_id = $1", [it.id]);
    if (existing) {
      const same = existing.action === req.action && (existing.counterparty ?? undefined) === req.counterparty;
      if (!same) throw new ApiError(409, "already_resolved", "This item was already resolved differently.");
      return { resolution: existing, replayed: true };
    }
    if (it.outcome !== "open") throw new ApiError(409, "item_not_open", `This item is ${it.outcome}; only open items need a decision.`);

    const { rows: latest } = await c.query<{ id: string }>(
      `SELECT id FROM reconciliation_runs WHERE source = $1 AND currency = $2 AND status = 'completed'
        ORDER BY started_at DESC LIMIT 1`,
      [it.source, it.currency],
    );
    if (latest[0]?.id !== it.run_id) {
      throw new ApiError(409, "stale_item", "A newer reconciliation run exists. Resolve this break from the latest run.");
    }

    if (it.object_id) {
      const table = it.object_type === "payout" ? "payouts" : "deposits";
      await c.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [it.object_id]);
    }
    const now = (await ledgerPositions(c, it.source, it.currency, it.break_key)).byKey.get(it.break_key) ?? { held: 0, settled: 0 };
    if (now.held !== it.ledger_held_cents || now.settled !== it.ledger_settled_cents) {
      throw new ApiError(409, "ledger_changed", "The ledger has changed for this item since the run. Run reconciliation again.");
    }

    let counterpartyId: string | undefined;
    if (req.action === "accept_provider") {
      if (!req.counterparty) throw new ApiError(400, "counterparty_required", "accept_provider needs counterparty: user or platform.");
      if (req.counterparty === "user" && !it.account_id) {
        throw new ApiError(422, "no_user", "This item belongs to no user account; the platform has to absorb it.");
      }
      counterpartyId = req.counterparty === "user" ? it.account_id! : await adjustmentsAccount(c, it.currency);
    } else if (req.counterparty) {
      throw new ApiError(400, "invalid_request", "counterparty applies to accept_provider only.");
    }

    const { rows: inserted } = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_resolutions (item_id, payout_id, break_key, fingerprint, action, counterparty, note, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        it.id,
        it.object_type === "payout" ? it.object_id : null,
        it.break_key,
        it.fingerprint,
        req.action,
        req.counterparty ?? null,
        req.note,
        req.resolved_by,
      ],
    );
    const resolutionId = inserted[0].id;

    if (req.action === "accept_provider") {
      const legs = await plan(
        c,
        it.source,
        it.currency,
        { held: it.ledger_held_cents, settled: it.ledger_settled_cents },
        { held: it.provider_held_cents, settled: it.provider_settled_cents },
        counterpartyId!,
      );
      for (const [n, leg] of legs.entries()) {
        const { transfer } = await createTransferInTx(
          c,
          `recon:${resolutionId}:${n + 1}`,
          { from_account_id: leg.from, to_account_id: leg.to, amount_cents: leg.amount, currency: it.currency },
          { scope: "system" },
        );
        if (transfer.status !== "posted") {
          // Rolls back everything, including the resolution itself.
          throw new ApiError(
            422,
            "insufficient_funds",
            "The user's balance cannot cover this correction. Choose counterparty platform to absorb it.",
          );
        }
        await c.query("INSERT INTO reconciliation_resolution_postings (resolution_id, transfer_id) VALUES ($1, $2)", [
          resolutionId,
          transfer.id,
        ]);
      }
    }

    const resolution = (await findResolution(c, "r.id = $1", [resolutionId]))!;
    await enqueueOutboxEvent(c, {
      eventType: "reconciliation.resolved",
      aggregateType: "reconciliation",
      aggregateId: resolution.id,
      payload: { ...resolution, created_at: resolution.created_at.toISOString() },
    });
    return { resolution, replayed: false };
  });
}

/** sha256 of the payout's discrepancy text: an acknowledgement covers exactly the notes it saw. */
export const discrepancyFingerprint = (discrepancy: string) => createHash("sha256").update(discrepancy).digest("hex");

/**
 * A person has looked at a payout the bank contradicted. No money moves (if
 * money disagrees, that is a reconciliation break and is resolved there).
 * Covers the discrepancy as it reads now; a new note from the bank flags the
 * payout again.
 */
export async function acknowledgeFlag(
  pool: pg.Pool,
  payoutId: string,
  req: { note: string; resolved_by: string },
): Promise<{ resolution: Resolution; replayed: boolean }> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<{ discrepancy: string | null }>("SELECT discrepancy FROM payouts WHERE id = $1 FOR UPDATE", [payoutId]);
    if (!rows[0]) throw new ApiError(404, "payout_not_found", "Payout not found.");
    if (!rows[0].discrepancy) throw new ApiError(409, "not_flagged", "This payout has no discrepancy to acknowledge.");
    const fp = discrepancyFingerprint(rows[0].discrepancy);
    const { rows: inserted } = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_resolutions (payout_id, break_key, fingerprint, action, note, resolved_by)
       VALUES ($1, $2, $3, 'acknowledge_flag', $4, $5)
       ON CONFLICT (payout_id, fingerprint) WHERE action = 'acknowledge_flag' DO NOTHING
       RETURNING id`,
      [payoutId, `payout:${payoutId}`, fp, req.note, req.resolved_by],
    );
    if (!inserted[0]) {
      const existing = await findResolution(c, "r.payout_id = $1 AND r.fingerprint = $2 AND r.action = 'acknowledge_flag'", [payoutId, fp]);
      return { resolution: existing!, replayed: true };
    }
    const resolution = (await findResolution(c, "r.id = $1", [inserted[0].id]))!;
    await enqueueOutboxEvent(c, {
      eventType: "reconciliation.flag_acknowledged",
      aggregateType: "reconciliation",
      aggregateId: resolution.id,
      payload: { ...resolution, created_at: resolution.created_at.toISOString() },
    });
    return { resolution, replayed: false };
  });
}

async function findResolution(db: pg.PoolClient | pg.Pool, where: string, params: unknown[]): Promise<Resolution | undefined> {
  const { rows } = await db.query<Resolution>(
    `SELECT ${RESOLUTION_COLUMNS} FROM reconciliation_resolutions r WHERE ${where}`,
    params,
  );
  return rows[0];
}

export async function listResolutions(pool: pg.Pool, limit = 50): Promise<Resolution[]> {
  const { rows } = await pool.query<Resolution>(
    `SELECT ${RESOLUTION_COLUMNS} FROM reconciliation_resolutions r ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
