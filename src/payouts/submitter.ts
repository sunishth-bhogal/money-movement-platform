import type pg from "pg";
import { BankConflictError, BankRejectedError, type BankClient } from "../bank/client.js";
import { withTransaction } from "../db.js";
import type { OutboxEvent } from "../outbox/outbox.js";
import { PermanentPublishError, type Publisher } from "../outbox/worker.js";
import { applyProviderState, bankIdempotencyKey, getPayout } from "./payouts.js";

/**
 * The outbox publisher for `payout.submit` events: sends the payout to the
 * bank. It runs inside the outbox worker, so it inherits leases, retries with
 * backoff, fencing and dead-lettering.
 *
 * Every attempt sends the same idempotency key, payout:<id>. That is what
 * makes retrying an unknown outcome safe: if an earlier attempt reached the
 * bank and only the response was lost, the bank returns the payout it already
 * has instead of paying twice.
 *
 *  - Bank accepted (or replayed): record what it says. Done.
 *  - Bank refused (422): the bank holds no money for it. Mark failed and
 *    reverse the hold. Done; retrying would be refused again.
 *  - Timeout, outage, 5xx: throw. The outcome is unknown, so we do not touch
 *    the payout; the worker retries later with the same key.
 *  - Key conflict (409): our bug. The event goes to `dead` for a person.
 */
export function payoutSubmitter(pool: pg.Pool, bank: BankClient): Publisher {
  return {
    async publish(event: OutboxEvent, signal: AbortSignal) {
      const { payout_id } = event.payload as { payout_id: string };
      const payout = await getPayout(pool, payout_id);
      if (!payout) throw new PermanentPublishError(`payout ${payout_id} does not exist`);
      // Already acknowledged or finished (e.g. a webhook arrived before our
      // response did). Nothing left to send.
      if (payout.status !== "pending") return;

      let bankPayout;
      try {
        bankPayout = await bank.createPayout(
          {
            idempotency_key: bankIdempotencyKey(payout.id),
            reference: payout.id,
            amount_cents: payout.amount_cents,
            currency: payout.currency,
            account_number: payout.bank_account_number,
          },
          signal,
        );
      } catch (err) {
        if (err instanceof BankRejectedError) {
          const rejected = err.payout ?? {
            id: `rejected:${payout.id}`,
            status: "failed" as const,
            amount_cents: payout.amount_cents,
            currency: payout.currency,
            failure_code: err.code,
          };
          await withTransaction(pool, (c) => applyProviderState(c, payout.id, rejected, "submit_response"));
          return;
        }
        if (err instanceof BankConflictError) throw new PermanentPublishError(err.message);
        throw err; // unknown outcome: retry later with the same key
      }
      await withTransaction(pool, (c) => applyProviderState(c, payout.id, bankPayout, "submit_response"));
    },
  };
}
