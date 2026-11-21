import type pg from "pg";
import type { BankClient } from "../bank/client.js";
import { withTransaction } from "../db.js";
import { requeueDeadEvent } from "../outbox/outbox.js";
import { applyProviderState, bankIdempotencyKey, PAYOUT_SUBMIT_EVENT, type ProviderUpdateOutcome } from "./payouts.js";

export interface ReconcileOptions {
  /** Only look at open payouts that have not changed for this long. Gives webhooks a chance first. */
  quietForMs?: number;
  limit?: number;
  signalTimeoutMs?: number;
  /** Only these payouts (an operator re-checking specific ones). Default: every open payout. */
  ids?: string[];
}

export interface ReconcileResult {
  checked: number;
  /** The bank had news, and we applied it. */
  updated: number;
  /** The bank never received it and nothing was going to send it again, so we queued it again. */
  resubmitted: number;
  /** The bank had not received it, but a submit attempt is still scheduled. Left alone. */
  inProgress: number;
  discrepancies: number;
  /** The bank could not be asked (outage). Tried again on the next run. */
  unreachable: number;
  outcomes: Record<string, ProviderUpdateOutcome | "resubmitted" | "in_progress" | "unreachable" | "missing_at_bank">;
}

/**
 * Asks the bank about payouts we still consider open, and applies the answer.
 * This is how we recover when the bank's state and ours differ and nobody
 * told us: a lost response followed by an outage, webhooks that never
 * arrived, a submit event that ran out of retries.
 *
 * The lookup is by idempotency key, which we can compute from the payout id
 * alone, so it works even if we never learned the bank's payout id.
 *
 *  bank says                      we do
 *  processing/succeeded/failed/…  applyProviderState (same rules as a webhook)
 *  never heard of it, payout      if the submit event is dead, queue it again
 *    `pending`                    (same key, so safe); otherwise leave it, a
 *                                 retry is already scheduled
 *  never heard of it, payout      discrepancy: the bank acknowledged it once
 *    `submitted`                  and has now lost it. A person looks.
 *  unreachable                    nothing; next run
 *
 * Note what is NOT here: "the bank never heard of it, so mark it failed".
 * Absence of evidence is not a failure. A request can still be in flight, and
 * failing it would return the money to the user while the bank may yet pay it
 * out. Only the bank can say a payout failed.
 */
export async function reconcilePayouts(
  pool: pg.Pool,
  bank: BankClient,
  { quietForMs = 5 * 60_000, limit = 100, signalTimeoutMs = 10_000, ids }: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checked: 0,
    updated: 0,
    resubmitted: 0,
    inProgress: 0,
    discrepancies: 0,
    unreachable: 0,
    outcomes: {},
  };
  const { rows } = await pool.query<{ id: string; status: "pending" | "submitted" }>(
    `SELECT id, status FROM payouts
      WHERE status IN ('pending', 'submitted')
        AND updated_at <= now() - make_interval(secs => $1::double precision / 1000)
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY updated_at
      LIMIT $2`,
    [quietForMs, limit, ids ?? null],
  );

  for (const payout of rows) {
    result.checked++;
    let bankPayout;
    try {
      bankPayout = await bank.getPayoutByKey(bankIdempotencyKey(payout.id), AbortSignal.timeout(signalTimeoutMs));
    } catch {
      result.unreachable++;
      result.outcomes[payout.id] = "unreachable";
      continue;
    }

    if (bankPayout) {
      const { outcome } = await withTransaction(pool, (c) => applyProviderState(c, payout.id, bankPayout, "status_lookup"));
      result.outcomes[payout.id] = outcome;
      if (outcome === "discrepancy") result.discrepancies++;
      else if (outcome !== "no_change") result.updated++;
      // Touch the row so a payout the bank is still working on goes to the
      // back of the queue instead of being asked about on every run.
      if (outcome === "no_change") await pool.query("UPDATE payouts SET updated_at = now() WHERE id = $1", [payout.id]);
      continue;
    }

    if (payout.status === "submitted") {
      await pool.query(
        `UPDATE payouts SET discrepancy = concat_ws(E'\\n', discrepancy, $2::text), updated_at = now() WHERE id = $1`,
        [payout.id, `${new Date().toISOString()} status_lookup: bank has no record of a payout it acknowledged`],
      );
      const outcome = "missing_at_bank" as const;
      result.outcomes[payout.id] = outcome;
      result.discrepancies++;
      continue;
    }

    // Pending, and the bank never got it. Is anything still going to send it?
    const { rows: events } = await pool.query<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM outbox
        WHERE aggregate_type = 'payout' AND aggregate_id = $1 AND event_type = $2`,
      [payout.id, PAYOUT_SUBMIT_EVENT],
    );
    const dead = events.find((e) => e.status === "dead");
    if (dead && (await requeueDeadEvent(pool, dead.event_id))) {
      await pool.query("UPDATE payouts SET updated_at = now() WHERE id = $1", [payout.id]);
      result.resubmitted++;
      result.outcomes[payout.id] = "resubmitted";
    } else {
      result.inProgress++;
      result.outcomes[payout.id] = "in_progress";
    }
  }
  return result;
}
