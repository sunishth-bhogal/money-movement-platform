import type pg from "pg";
import { createTransferInTx } from "../ledger/transfers.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { creditBucket, debitOrganizer, eventOrganizers, lockEvent, postForOrganizer } from "./catalog.js";
import { allocate, DISPUTE_FEE_CENTS, formatCents, platformFeesAccount, reductionShares, stripeDisputesAccount, type Share } from "./money.js";
import { lockOrder, orderRemaining } from "./orders.js";
import { postReduction } from "./refunds.js";

export type DisputeEventType = "charge.dispute.created" | "charge.dispute.closed";
export const DISPUTE_EVENTS: ReadonlySet<string> = new Set<DisputeEventType>(["charge.dispute.created", "charge.dispute.closed"]);
export type DisputeOutcome = "dispute_opened" | "dispute_won" | "dispute_lost" | "dispute_no_change";

/** The fields of a Stripe Dispute that we rely on. */
export interface DisputeFields {
  id: string;
  amount: number;
  currency: string;
  payment_intent: string | { id: string } | null;
  status: string;
  reason: string;
}

export interface Dispute {
  id: string;
  stripe_dispute_id: string;
  order_id: string;
  amount_cents: number;
  fee_cents: number;
  currency: string;
  reason: string;
  status: "open" | "won" | "lost";
  shares: Share[];
  created_at: Date;
  closed_at: Date | null;
}

const DISPUTE_COLUMNS = "id, stripe_dispute_id, order_id, amount_cents, fee_cents, currency, reason, status, shares, created_at, closed_at";

export async function orderDisputes(db: pg.Pool | pg.PoolClient, orderId: string): Promise<Dispute[]> {
  const { rows } = await db.query<Dispute>(`SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  return rows;
}

/**
 * Apply a Stripe chargeback to a ticket order, inside the webhook's
 * transaction (after its event id was recorded, so a redelivery is skipped).
 *
 * Opened: Stripe has already taken the disputed amount and its fee from us.
 * We pass that on at once, per organizer, the same way as a refund (the
 * platform fee on that part goes back to them, the part itself comes out),
 * plus the dispute fee. From the event's held money if it has not been paid
 * out, otherwise from their available balance. When the event has already
 * been paid out, that balance goes negative: the organizer owes it, and
 * their next payout is smaller by that much, with this dispute as the reason.
 *
 * If Stripe disputes more than is left on the order (it was partly refunded),
 * the platform absorbs the excess: no organizer sold it.
 *
 * Won: the disputed amount comes back to the organizers (and the platform
 * takes its fee on it again). The dispute fee does not: that is our policy.
 * Lost: nothing moves; the money left when it opened.
 *
 * Inquiries (Stripe's warning_* statuses) take no money and are ignored.
 */
export async function applyDisputeEvent(
  c: pg.PoolClient,
  type: DisputeEventType,
  d: DisputeFields,
): Promise<{ outcome: DisputeOutcome | "ignored"; order_id?: string; dispute_id?: string }> {
  if (d.status.startsWith("warning")) return { outcome: "ignored" };
  const pi = typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
  if (!pi) return { outcome: "ignored" };
  const { rows: found } = await c.query<{ id: string; event_id: string }>(
    "SELECT id, event_id FROM orders WHERE stripe_payment_intent_id = $1",
    [pi],
  );
  if (!found[0]) return { outcome: "ignored" };
  const event = await lockEvent(c, found[0].event_id);
  const order = (await lockOrder(c, found[0].id))!;
  const { rows: existingRows } = await c.query<Dispute>(
    `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE stripe_dispute_id = $1 FOR UPDATE`,
    [d.id],
  );
  let dispute = existingRows[0];
  const orgs = await eventOrganizers(c, event.id);
  const toStripe = await stripeDisputesAccount(c, order.currency);
  const fees = await platformFeesAccount(c, order.currency);

  if (!dispute) {
    if (type === "charge.dispute.closed" && d.status !== "lost" && d.status !== "won") return { outcome: "ignored" };
    if (order.status !== "paid") return { outcome: "ignored", order_id: order.id };
    const remaining = await orderRemaining(c, order);
    const covered = Math.min(d.amount, remaining.total);
    const shares = covered > 0 ? reductionShares(covered, remaining.shares) : remaining.shares.map((s) => ({ ...s, gross_cents: 0, fee_cents: 0 }));
    const { rows } = await c.query<Dispute>(
      `INSERT INTO disputes (stripe_dispute_id, order_id, amount_cents, fee_cents, currency, reason, shares)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${DISPUTE_COLUMNS}`,
      [d.id, order.id, d.amount, DISPUTE_FEE_CENTS, order.currency, d.reason, JSON.stringify(shares)],
    );
    dispute = rows[0];
    const ctx = { orderId: order.id, disputeId: dispute.id };
    await postReduction(c, `dispute:${dispute.id}`, event, order, shares, toStripe, {
      kind: "dispute",
      memo: `Chargeback by ${order.buyer_name}'s bank (${d.reason})`,
      feeMemo: "Platform fee returned on the charged-back amount",
      ctx,
    });
    // The dispute fee, split like the money (by share of the sale).
    const weights = shares.some((s) => s.gross_cents > 0)
      ? shares.map((s) => ({ weight: s.gross_cents }))
      : orgs.map((o) => ({ weight: o.share_bps }));
    const feeParts = allocate(dispute.fee_cents, weights);
    for (const [i, share] of shares.entries()) {
      const org = orgs.find((o) => o.organizer_id === share.organizer_id)!;
      await debitOrganizer(c, `dispute:${dispute.id}:charge:${org.organizer_id}`, org, event.id, feeParts[i], toStripe, order.currency, {
        kind: "dispute_fee",
        memo: `Chargeback fee (${formatCents(dispute.fee_cents, order.currency)}, charged by Stripe whatever the outcome)`,
        ctx,
      });
    }
    const excess = d.amount - covered;
    if (excess > 0) {
      await createTransferInTx(
        c,
        `dispute:${dispute.id}:platform`,
        { from_account_id: fees, to_account_id: toStripe, amount_cents: excess, currency: order.currency },
        { scope: "system" },
      );
    }
    await enqueueOutboxEvent(c, {
      eventType: "dispute.opened",
      aggregateType: "dispute",
      aggregateId: dispute.id,
      payload: { id: dispute.id, order_id: order.id, amount_cents: d.amount, currency: order.currency, reason: d.reason },
    });
    if (type === "charge.dispute.created" || d.status === "lost") {
      if (type === "charge.dispute.closed") await closeDispute(c, dispute.id, "lost");
      return { outcome: type === "charge.dispute.created" ? "dispute_opened" : "dispute_lost", order_id: order.id, dispute_id: dispute.id };
    }
  }

  if (type !== "charge.dispute.closed" || dispute.status !== "open") {
    return { outcome: "dispute_no_change", order_id: order.id, dispute_id: dispute.id };
  }
  if (d.status === "lost") {
    await closeDispute(c, dispute.id, "lost");
    return { outcome: "dispute_lost", order_id: order.id, dispute_id: dispute.id };
  }
  if (d.status !== "won") return { outcome: "dispute_no_change", order_id: order.id, dispute_id: dispute.id };

  const ctx = { eventId: event.id, orderId: order.id, disputeId: dispute.id };
  for (const share of dispute.shares) {
    const org = orgs.find((o) => o.organizer_id === share.organizer_id)!;
    const bucket = creditBucket(event, org);
    await postForOrganizer(
      c,
      `dispute:${dispute.id}:won:${org.organizer_id}`,
      { from: toStripe, to: bucket, amount: share.gross_cents, currency: order.currency },
      { organizerId: org.organizer_id, kind: "dispute_won", memo: "Chargeback decided in your favour: the amount is back", ctx },
    );
    await postForOrganizer(
      c,
      `dispute:${dispute.id}:won-fee:${org.organizer_id}`,
      { from: bucket, to: fees, amount: share.fee_cents, currency: order.currency },
      { organizerId: org.organizer_id, kind: "platform_fee", memo: "Platform fee on the amount returned from the chargeback", ctx },
    );
  }
  const covered = dispute.shares.reduce((sum, s) => sum + s.gross_cents, 0);
  if (dispute.amount_cents > covered) {
    await createTransferInTx(
      c,
      `dispute:${dispute.id}:platform-won`,
      { from_account_id: toStripe, to_account_id: fees, amount_cents: dispute.amount_cents - covered, currency: order.currency },
      { scope: "system" },
    );
  }
  await closeDispute(c, dispute.id, "won");
  return { outcome: "dispute_won", order_id: order.id, dispute_id: dispute.id };
}

async function closeDispute(c: pg.PoolClient, id: string, status: "won" | "lost") {
  const { rows } = await c.query<{ order_id: string; amount_cents: number }>(
    "UPDATE disputes SET status = $2, closed_at = now() WHERE id = $1 RETURNING order_id, amount_cents",
    [id, status],
  );
  await enqueueOutboxEvent(c, {
    eventType: `dispute.${status}`,
    aggregateType: "dispute",
    aggregateId: id,
    payload: { id, order_id: rows[0].order_id, amount_cents: rows[0].amount_cents, status },
  });
}
