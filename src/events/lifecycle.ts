import type pg from "pg";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { createPayoutInTx, getPayout, inFlightAccount, type Payout } from "../payouts/payouts.js";
import { recordOrganizerPosting } from "../organizers/postings.js";
import { createTransferInTx } from "../ledger/transfers.js";
import {
  eventOrganizers,
  getOrganizer,
  heldForEvent,
  lockEvent,
  postForOrganizer,
  releaseDueAt,
  type EventOrganizer,
  type EventRow,
} from "./catalog.js";
import { formatCents, organizerAdjustmentsAccount } from "./money.js";
import { orderRemaining, toOrder, ORDER_COLUMNS, type OrderRow } from "./orders.js";
import { createRefundInTx, type Refund } from "./refunds.js";

/**
 * What happens to an event's money over time:
 *
 *   on sale ──(ended + hold_hours)──► released: held → available, then paid out
 *      │  └─(advance, before the event)─► part of held → available, paid out early
 *      └──(cancelled)──► every paid order refunded; never released
 */

// ---- cancellation -----------------------------------------------------------

/**
 * Cancel an event and refund every customer in full, in ONE transaction:
 * the event stops selling, and each paid order gets a refund for whatever is
 * left on it (createRefundInTx: organizers' held money first, then their
 * balance). The refunds go to Stripe through the outbox after commit, so a
 * cancellation never waits on, or half-fails because of, a provider.
 *
 * Orders still being paid when it is cancelled are refunded as soon as their
 * payment arrives (see applyOrderCheckoutEvent). An event whose money was
 * already released cannot be cancelled this way: refund its tickets one by one.
 */
export async function cancelEvent(
  pool: pg.Pool,
  eventId: string,
  req: { reason: string; requested_by: string },
): Promise<{ event: EventRow; refunds: Refund[]; replayed: boolean }> {
  return withTransaction(pool, async (c) => {
    const event = await lockEvent(c, eventId);
    if (event.status === "cancelled") return { event, refunds: [], replayed: true };
    if (event.released_at) {
      throw new ApiError(409, "already_released", "This event's money was already paid out to its organizers; refund tickets individually.");
    }
    const { rows: cancelled } = await c.query<EventRow>(
      `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1
       RETURNING id, name, venue, currency, starts_at, ends_at, fee_bps, fee_fixed_cents, hold_hours, advance_bps, status,
                 cancelled_at, cancel_reason, released_at, created_at`,
      [event.id, req.reason],
    );
    const { rows: orders } = await c.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE event_id = $1 AND status = 'paid' ORDER BY created_at, id`,
      [event.id],
    );
    const refunds: Refund[] = [];
    for (const row of orders) {
      const order = toOrder(row);
      if ((await orderRemaining(c, order)).total === 0) continue;
      const { refund } = await createRefundInTx(c, `event:${event.id}:cancel:order:${order.id}`, {
        order_id: order.id,
        reason: "event_cancelled",
        note: req.reason,
        requested_by: req.requested_by,
      });
      refunds.push(refund);
    }
    await enqueueOutboxEvent(c, {
      eventType: "event.cancelled",
      aggregateType: "event",
      aggregateId: event.id,
      payload: { id: event.id, reason: req.reason, refunds: refunds.length },
    });
    return { event: cancelled[0], refunds, replayed: false };
  });
}

// ---- paying organizers ------------------------------------------------------

/**
 * Pay out an organizer's whole available balance, if it is positive. The
 * balance is read under the account's lock (taken in id order with "Payouts
 * in flight", the same order createTransferInTx uses), so two payouts at once
 * cannot both pay the same money; the hold also has requireFunds.
 *
 * A negative or zero balance pays nothing: the organizer owes us, and the
 * money just released (or advanced) went to cover that. Their statement says so.
 */
export async function payoutAvailableInTx(
  c: pg.PoolClient,
  org: Pick<EventOrganizer, "organizer_id" | "available_account_id" | "bank_account_number">,
  key: string,
  currency: string,
  context: { eventId?: string | null; memo: string },
): Promise<Payout | null> {
  const { rows: existing } = await c.query<{ id: string }>("SELECT id FROM payouts WHERE idempotency_key = $1", [key]);
  if (existing[0]) return (await getPayout(c, existing[0].id))!;
  const inFlight = await inFlightAccount(c, currency);
  const { rows } = await c.query<{ id: string; balance_cents: number }>(
    "SELECT id, balance_cents FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
    [[org.available_account_id, inFlight]],
  );
  const available = rows.find((r) => r.id === org.available_account_id)!.balance_cents;
  if (available <= 0) return null;
  const { payout } = await createPayoutInTx(
    c,
    key,
    { account_id: org.available_account_id, amount_cents: available, currency, bank_account_number: org.bank_account_number },
    { organizerId: org.organizer_id, eventId: context.eventId, memo: context.memo },
  );
  return payout;
}

export interface ReleaseResult {
  event_id: string;
  organizers: { organizer_id: string; released_cents: number; payout: Payout | null }[];
}

/**
 * After an event (and its hold period): move each organizer's held proceeds
 * to their available balance, and pay that balance out. One transaction per
 * event, under its lock; keyed event:<id>:release:<organizer> and
 * event:<id>:payout:<organizer>, and released_at is set once, so running the
 * schedule again (or on two workers at once) releases and pays once.
 */
export async function releaseEvent(pool: pg.Pool, eventId: string, now = new Date()): Promise<ReleaseResult | null> {
  return withTransaction(pool, async (c) => {
    const event = await lockEvent(c, eventId);
    if (event.status !== "on_sale" || event.released_at || releaseDueAt(event) > now) return null;
    const orgs = await eventOrganizers(c, event.id);
    const result: ReleaseResult = { event_id: event.id, organizers: [] };
    for (const org of orgs) {
      const held = await heldForEvent(c, org, event.id);
      await postForOrganizer(
        c,
        `event:${event.id}:release:${org.organizer_id}`,
        { from: org.held_account_id, to: org.available_account_id, amount: held, currency: event.currency },
        { organizerId: org.organizer_id, kind: "release", memo: `${event.name} has taken place: proceeds released`, ctx: { eventId: event.id } },
      );
      const payout = await payoutAvailableInTx(c, org, `event:${event.id}:payout:${org.organizer_id}`, event.currency, {
        eventId: event.id,
        memo: `Payout after ${event.name}`,
      });
      result.organizers.push({ organizer_id: org.organizer_id, released_cents: held, payout });
    }
    await c.query("UPDATE events SET released_at = now() WHERE id = $1", [event.id]);
    await enqueueOutboxEvent(c, {
      eventType: "event.released",
      aggregateType: "event",
      aggregateId: event.id,
      payload: result,
    });
    return result;
  });
}

/** Release every event that is due. The worker runs this on a timer; it is safe to run anywhere, any number of times. */
export async function runPayoutSchedule(pool: pg.Pool, now = new Date()): Promise<ReleaseResult[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM events
      WHERE status = 'on_sale' AND released_at IS NULL
        AND ends_at + make_interval(hours => hold_hours) <= $1
      ORDER BY ends_at LIMIT 100`,
    [now],
  );
  const results: ReleaseResult[] = [];
  for (const e of rows) {
    const r = await releaseEvent(pool, e.id, now);
    if (r) results.push(r);
  }
  return results;
}

/**
 * An early payout of part of an organizer's held proceeds, before the event
 * (if the event allows it: advance_bps). One per organizer per event.
 *
 * This is the risky one for the platform: if the event is then cancelled,
 * every customer is refunded in full, and the advanced money has already left.
 * The organizer's balance goes negative by that much, and it is recovered
 * from their next payout, or by a recorded adjustment.
 */
export async function takeAdvance(
  pool: pg.Pool,
  eventId: string,
  organizerId: string,
): Promise<{ advance_cents: number; payout: Payout | null; replayed: boolean }> {
  return withTransaction(pool, async (c) => {
    const event = await lockEvent(c, eventId);
    const org = (await eventOrganizers(c, event.id)).find((o) => o.organizer_id === organizerId);
    if (!org) throw new ApiError(404, "event_not_found", "Event not found.");
    const key = `event:${event.id}:advance:${org.organizer_id}`;
    const { rows: done } = await c.query<{ amount_cents: number }>("SELECT amount_cents FROM transfers WHERE idempotency_scope = 'system' AND idempotency_key = $1", [key]);
    if (done[0]) {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM payouts WHERE idempotency_key = $1", [`${key}:payout`]);
      const payout = rows[0] ? ((await getPayout(c, rows[0].id)) ?? null) : null;
      return { advance_cents: done[0].amount_cents, payout, replayed: true };
    }
    if (event.advance_bps === 0) throw new ApiError(422, "advance_not_offered", "This event does not offer early payouts.");
    if (event.status !== "on_sale") throw new ApiError(409, "event_cancelled", "This event was cancelled.");
    if (event.released_at || event.starts_at.getTime() <= Date.now()) {
      throw new ApiError(409, "event_started", "Advances are only before the event; its proceeds are released after it.");
    }
    const held = await heldForEvent(c, org, event.id);
    const amount = Number((BigInt(held) * BigInt(event.advance_bps)) / 10_000n);
    if (amount <= 0) throw new ApiError(409, "nothing_to_advance", "Nothing is held for you for this event yet.");
    await postForOrganizer(
      c,
      key,
      { from: org.held_account_id, to: org.available_account_id, amount, currency: event.currency },
      {
        organizerId: org.organizer_id,
        kind: "advance",
        memo: `Early payout: ${event.advance_bps / 100}% of the ${formatCents(held, event.currency)} held for ${event.name}`,
        ctx: { eventId: event.id },
      },
    );
    const payout = await payoutAvailableInTx(c, org, `${key}:payout`, event.currency, {
      eventId: event.id,
      memo: `Early payout for ${event.name}`,
    });
    return { advance_cents: amount, payout, replayed: false };
  });
}

// ---- a person's decision ----------------------------------------------------

export const ADJUSTMENT_CAUSES = ["organizer_repaid", "debt_written_off", "goodwill_credit", "correction"] as const;
export type AdjustmentCause = (typeof ADJUSTMENT_CAUSES)[number];

export interface AdjustmentRequest {
  organizer_id: string;
  amount_cents: number;
  cause: AdjustmentCause;
  note: string;
  decided_by: string;
  event_id?: string;
  order_id?: string;
  dispute_id?: string;
}

const CAUSE_MEMO: Record<AdjustmentCause, string> = {
  organizer_repaid: "You repaid what you owed",
  debt_written_off: "What you owed was written off",
  goodwill_credit: "Goodwill credit",
  correction: "Correction",
};

/**
 * Change what an organizer is owed by a person's decision: an organizer who
 * repaid a debt by bank transfer, a debt the platform writes off, a goodwill
 * credit. Never a silent edit: a new ledger transfer against "Organizer
 * adjustments", an append-only row with the cause, the decision note and who
 * made it, and a line on the organizer's statement. Idempotent on its key.
 */
export async function recordAdjustment(pool: pg.Pool, idempotencyKey: string, req: AdjustmentRequest) {
  return withTransaction(pool, async (c) => {
    const { rows: existing } = await c.query("SELECT * FROM organizer_adjustments WHERE idempotency_key = $1", [idempotencyKey]);
    if (existing[0]) return { adjustment: existing[0], replayed: true };
    const org = await getOrganizer(c, req.organizer_id);
    if (!org) throw new ApiError(404, "organizer_not_found", "Organizer not found.");
    const other = await organizerAdjustmentsAccount(c, org.currency);
    const credit = req.amount_cents > 0;
    const { transfer } = await createTransferInTx(
      c,
      `adjustment:${idempotencyKey}`,
      {
        from_account_id: credit ? other : org.available_account_id,
        to_account_id: credit ? org.available_account_id : other,
        amount_cents: Math.abs(req.amount_cents),
        currency: org.currency,
      },
      { scope: "system" },
    );
    const { rows } = await c.query(
      `INSERT INTO organizer_adjustments
         (idempotency_key, organizer_id, amount_cents, currency, cause, note, decided_by, event_id, order_id, dispute_id, transfer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [idempotencyKey, org.id, req.amount_cents, org.currency, req.cause, req.note, req.decided_by, req.event_id ?? null, req.order_id ?? null, req.dispute_id ?? null, transfer.id],
    );
    await recordOrganizerPosting(c, transfer.id, org.id, "adjustment", `${CAUSE_MEMO[req.cause]}: ${req.note} (decided by ${req.decided_by})`, {
      adjustmentId: rows[0].id,
      eventId: req.event_id,
      orderId: req.order_id,
      disputeId: req.dispute_id,
    });
    await enqueueOutboxEvent(c, {
      eventType: "organizer.adjusted",
      aggregateType: "organizer",
      aggregateId: org.id,
      payload: { adjustment_id: rows[0].id, amount_cents: req.amount_cents, cause: req.cause, decided_by: req.decided_by },
    });
    return { adjustment: rows[0], replayed: false };
  });
}
