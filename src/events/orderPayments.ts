import type pg from "pg";
import type { CheckoutSessionEvent, SessionFields } from "../payments/deposits.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { creditBucket, eventOrganizers, lockEvent, postForOrganizer } from "./catalog.js";
import { formatCents, platformFeesAccount, saleShares, stripeClearingAccount } from "./money.js";
import { lockOrder, ORDER_FINAL, type OrderStatus } from "./orders.js";
import { createRefundInTx } from "./refunds.js";

export type OrderWebhookOutcome = "ignored" | "already_final" | `order_${OrderStatus}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Move a ticket order towards what Stripe says about its Checkout Session.
 * Called from the Stripe webhook (and by reconciliation, for a payment whose
 * webhook never came), inside its transaction, after the event id was
 * recorded. Credits a payment at most once: the order row lock, the final
 * state check, and the order:<id>:sale:<organizer> transfer keys.
 *
 * On payment, per organizer of the event:
 *   Stripe clearing → organizer (their share of the ticket price)   ticket_sale
 *   organizer → Platform fees (their share of the fee)               platform_fee
 * into the organizer's held account, or straight to available if the event's
 * money was already released (a slow bank debit that cleared after the event).
 *
 * If the event was cancelled while the customer was paying, the payment is
 * still recorded (Stripe has the money) and refunded in full right away.
 */
export async function applyOrderCheckoutEvent(
  client: pg.PoolClient,
  type: CheckoutSessionEvent,
  session: SessionFields,
): Promise<{ outcome: OrderWebhookOutcome; order_id?: string }> {
  const orderId = session.metadata?.order_id ?? session.client_reference_id;
  if (!orderId || !UUID_RE.test(orderId)) return { outcome: "ignored" };
  const { rows } = await client.query<{ event_id: string }>("SELECT event_id FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return { outcome: "ignored" };

  // Event, then order: the lock order every money operation on an event uses.
  const event = await lockEvent(client, rows[0].event_id);
  const order = (await lockOrder(client, orderId))!;
  if (order.stripe_checkout_session_id && order.stripe_checkout_session_id !== session.id) {
    return { outcome: "ignored", order_id: order.id };
  }
  if (ORDER_FINAL.has(order.status)) return { outcome: "already_final", order_id: order.id };

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  const setStatus = async (status: OrderStatus, extra: { reason?: string; shares?: unknown } = {}) => {
    await client.query(
      `UPDATE orders
          SET status = $2,
              failure_reason = $3,
              sale_shares = COALESCE($4::jsonb, sale_shares),
              paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END,
              stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $5),
              stripe_payment_intent_id = COALESCE($6, stripe_payment_intent_id),
              updated_at = now()
        WHERE id = $1`,
      [order.id, status, extra.reason ?? null, extra.shares ? JSON.stringify(extra.shares) : null, session.id, paymentIntentId],
    );
    if (status === "paid") await client.query("UPDATE tickets SET status = 'valid' WHERE order_id = $1 AND status = 'reserved'", [order.id]);
    if (status === "failed" || status === "expired") {
      // The seats go back on sale.
      await client.query("UPDATE tickets SET status = 'released' WHERE order_id = $1 AND status = 'reserved'", [order.id]);
    }
    await enqueueOutboxEvent(client, {
      eventType: `order.${status}`,
      aggregateType: "order",
      aggregateId: order.id,
      payload: { id: order.id, event_id: order.event_id, amount_cents: order.amount_cents, currency: order.currency, status },
    });
    return { outcome: `order_${status}` as OrderWebhookOutcome, order_id: order.id };
  };

  const paid =
    type === "checkout.session.async_payment_succeeded" ||
    (type === "checkout.session.completed" && session.payment_status === "paid");

  if (paid) {
    if (session.amount_total !== order.amount_cents || session.currency?.toUpperCase() !== order.currency) {
      return setStatus("requires_review", {
        reason: `amount_mismatch: expected ${order.amount_cents} ${order.currency}, got ${session.amount_total} ${session.currency}`,
      });
    }
    const orgs = await eventOrganizers(client, event.id);
    const shares = saleShares(order.amount_cents, order.fee_cents, orgs);
    const { rows: counted } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM tickets WHERE order_id = $1", [order.id]);
    const n = counted[0].n;
    const clearing = await stripeClearingAccount(client, order.currency);
    const fees = await platformFeesAccount(client, order.currency);
    for (const share of shares) {
      const org = orgs.find((o) => o.organizer_id === share.organizer_id)!;
      const bucket = creditBucket(event, org);
      const split = orgs.length > 1 ? ` (your ${org.share_bps / 100}% share)` : "";
      const ctx = { eventId: event.id, orderId: order.id };
      await postForOrganizer(
        client,
        `order:${order.id}:sale:${org.organizer_id}`,
        { from: clearing, to: bucket, amount: share.gross_cents, currency: order.currency },
        { organizerId: org.organizer_id, kind: "ticket_sale", memo: `${n} ticket${n === 1 ? "" : "s"} sold to ${order.buyer_name}${split}`, ctx },
      );
      await postForOrganizer(
        client,
        `order:${order.id}:fee:${org.organizer_id}`,
        { from: bucket, to: fees, amount: share.fee_cents, currency: order.currency },
        {
          organizerId: org.organizer_id,
          kind: "platform_fee",
          memo: `Platform fee: ${event.fee_bps / 100}% + ${formatCents(event.fee_fixed_cents, order.currency)} per ticket${split}`,
          ctx,
        },
      );
    }
    const result = await setStatus("paid", { shares });
    if (event.status === "cancelled") {
      await createRefundInTx(client, `event:${event.id}:cancel:order:${order.id}`, {
        order_id: order.id,
        reason: "event_cancelled",
        note: "Paid after the event was cancelled",
        requested_by: "system",
      });
    }
    return result;
  }
  if (type === "checkout.session.completed") return setStatus("processing");
  if (type === "checkout.session.async_payment_failed") return setStatus("failed", { reason: "async_payment_failed" });
  return setStatus("expired", { reason: "checkout_session_expired" });
}
