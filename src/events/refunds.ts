import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import Stripe from "stripe";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { createTransferInTx } from "../ledger/transfers.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { PermanentPublishError, type Publisher } from "../outbox/worker.js";
import { assertTestModeKey } from "../payments/stripe.js";
import { creditBucket, debitOrganizer, eventOrganizers, lockEvent, postForOrganizer, type EventRow } from "./catalog.js";
import { formatCents, platformFeesAccount, reductionShares, refundsInFlightAccount, stripeRefundsAccount, type Share } from "./money.js";
import { lockOrder, orderRemaining, orderTickets, type Order } from "./orders.js";

export type RefundReason = "event_cancelled" | "requested_by_customer" | "organizer_goodwill" | "duplicate";
export type RefundStatus = "pending" | "succeeded" | "requires_review";

export interface Refund {
  id: string;
  idempotency_key: string;
  order_id: string;
  ticket_id: string | null;
  amount_cents: number;
  currency: string;
  reason: RefundReason;
  note: string | null;
  requested_by: string;
  status: RefundStatus;
  stripe_refund_id: string | null;
  failure_reason: string | null;
  shares: Share[];
  created_at: Date;
  updated_at: Date;
}

export interface RefundRequest {
  order_id: string;
  /** Refund one ticket (all of it, or `amount_cents` of it). Without it: everything left on the order. */
  ticket_id?: string;
  amount_cents?: number;
  reason: RefundReason;
  note?: string;
  requested_by: string;
}

/** The outbox event that asks the worker to send a refund to Stripe. */
export const REFUND_SUBMIT_EVENT = "refund.submit";

const REFUND_COLUMNS =
  "id, idempotency_key, request_hash, order_id, ticket_id, amount_cents, currency, reason, note, requested_by, status, " +
  "stripe_refund_id, failure_reason, shares, created_at, updated_at";
type RefundRow = Refund & { request_hash: string };
const toRefund = ({ request_hash: _h, ...r }: RefundRow): Refund => r;

const REASON_LABEL: Record<RefundReason, string> = {
  event_cancelled: "event cancelled",
  requested_by_customer: "customer asked",
  organizer_goodwill: "goodwill",
  duplicate: "duplicate purchase",
};

export async function getRefund(db: pg.Pool | pg.PoolClient, id: string): Promise<Refund | undefined> {
  const { rows } = await db.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE id = $1`, [id]);
  return rows[0] && toRefund(rows[0]);
}

export async function orderRefunds(db: pg.Pool | pg.PoolClient, orderId: string): Promise<Refund[]> {
  const { rows } = await db.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE order_id = $1 ORDER BY created_at, id`, [orderId]);
  return rows.map(toRefund);
}

/**
 * Give money back to a customer. ONE transaction, no network call:
 *
 *  1. Under the event lock, then the order lock: work out what is left to
 *     refund on the order (and on the ticket, if one is named).
 *  2. Split the refund between the organizers in proportion to what each has
 *     left of the sale, and work out the platform fee that goes back with it.
 *  3. Post it: the platform's fee share back to each organizer, then the
 *     refund out of each organizer, from the event's held proceeds first and
 *     their available balance for the rest. Everything lands in "Refunds in
 *     flight", and every transfer has a posting that names the refund.
 *  4. Queue `refund.submit` in the outbox; the worker asks Stripe after commit.
 *
 * The customer's refund never waits for the organizer to have the money: if
 * the event's proceeds were already advanced or paid out, the organizer's
 * balance goes negative, and that negative balance is the organizer's
 * obligation, on their statement, with this refund as the reason.
 *
 * The caller may already hold the event lock (a cancellation refunds every
 * order inside its own transaction).
 */
export async function createRefundInTx(
  c: pg.PoolClient,
  idempotencyKey: string,
  req: RefundRequest,
): Promise<{ refund: Refund; replayed: boolean }> {
  const requestHash = createHash("sha256")
    .update(JSON.stringify([req.order_id, req.ticket_id ?? null, req.amount_cents ?? null, req.reason]))
    .digest("hex");
  const replay = (row: RefundRow) => {
    if (row.request_hash !== requestHash) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
    }
    return { refund: toRefund(row), replayed: true };
  };
  const findByKey = async () =>
    (await c.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];

  const existing = await findByKey();
  if (existing) return replay(existing);

  const { rows: o } = await c.query<{ event_id: string }>("SELECT event_id FROM orders WHERE id = $1", [req.order_id]);
  if (!o[0]) throw new ApiError(404, "order_not_found", "Order not found.");
  const event = await lockEvent(c, o[0].event_id);
  const order = (await lockOrder(c, req.order_id))!;
  if (order.status !== "paid") throw new ApiError(409, "order_not_paid", `This order is ${order.status}; only paid orders can be refunded.`);

  // Locked now: a concurrent request with the same key would be visible.
  const raced = await findByKey();
  if (raced) return replay(raced);

  const remaining = await orderRemaining(c, order);
  const tickets = await orderTickets(c, order.id);
  let amount: number;
  let ticket = undefined as (typeof tickets)[number] | undefined;
  if (req.ticket_id) {
    ticket = tickets.find((t) => t.id === req.ticket_id);
    if (!ticket) throw new ApiError(404, "ticket_not_found", "This ticket is not on this order.");
    const left = ticket.price_cents - ticket.refunded_cents;
    amount = req.amount_cents ?? left;
    if (amount > left) throw new ApiError(422, "amount_too_large", `Only ${formatCents(left, order.currency)} of this ticket is left to refund.`);
  } else {
    if (req.amount_cents !== undefined) {
      throw new ApiError(400, "ticket_required", "To refund part of an order, name the ticket (ticket_id) the refund is for.");
    }
    amount = remaining.total;
  }
  if (amount <= 0) throw new ApiError(409, "nothing_to_refund", "Nothing is left to refund on this order.");
  if (amount > remaining.total) {
    throw new ApiError(422, "amount_too_large", `Only ${formatCents(remaining.total, order.currency)} of this order is left to refund.`);
  }

  const shares = reductionShares(amount, remaining.shares);
  const { rows: inserted } = await c.query<RefundRow>(
    `INSERT INTO refunds (idempotency_key, request_hash, order_id, ticket_id, amount_cents, currency, reason, note, requested_by, shares)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${REFUND_COLUMNS}`,
    [idempotencyKey, requestHash, order.id, ticket?.id ?? null, amount, order.currency, req.reason, req.note ?? null, req.requested_by, JSON.stringify(shares)],
  );
  const refund = toRefund(inserted[0]);

  // The tickets this refund covers.
  if (ticket) {
    await c.query(
      `UPDATE tickets SET refunded_cents = refunded_cents + $2,
              status = CASE WHEN refunded_cents + $2 = price_cents THEN 'refunded' ELSE status END
        WHERE id = $1`,
      [ticket.id, amount],
    );
  } else {
    await c.query("UPDATE tickets SET refunded_cents = price_cents, status = 'refunded' WHERE order_id = $1 AND status = 'valid'", [order.id]);
  }

  await postReduction(c, `refund:${refund.id}`, event, order, shares, await refundsInFlightAccount(c, order.currency), {
    kind: "refund",
    feeMemo: `Platform fee returned on refund of ${ticket ? `a ${ticket.ticket_type} ticket` : "the order"} (${REASON_LABEL[req.reason]})`,
    memo: `Refund to ${order.buyer_name}${ticket ? ` for a ${ticket.ticket_type} ticket` : ""} (${REASON_LABEL[req.reason]})`,
    ctx: { orderId: order.id, ticketId: ticket?.id ?? null, refundId: refund.id },
  });

  await enqueueOutboxEvent(c, {
    eventType: "refund.created",
    aggregateType: "refund",
    aggregateId: refund.id,
    payload: { id: refund.id, order_id: order.id, amount_cents: amount, currency: order.currency, reason: req.reason },
  });
  await enqueueOutboxEvent(c, {
    eventType: REFUND_SUBMIT_EVENT,
    aggregateType: "refund",
    aggregateId: refund.id,
    payload: { refund_id: refund.id },
  });
  return { refund, replayed: false };
}

export async function createRefund(pool: pg.Pool, idempotencyKey: string, req: RefundRequest) {
  return withTransaction(pool, (c) => createRefundInTx(c, idempotencyKey, req));
}

/**
 * Post a refund or chargeback against an order, per organizer:
 *   + the platform fee on that part, back to the organizer (fee_returned)
 *   − the part itself, out of the organizer, to `to`  (refund / dispute)
 * Both legs land where the event's money currently is for that organizer.
 */
export async function postReduction(
  c: pg.PoolClient,
  keyBase: string,
  event: EventRow,
  order: Order,
  shares: Share[],
  to: string,
  posting: { kind: "refund" | "dispute"; memo: string; feeMemo: string; ctx: { orderId: string; ticketId?: string | null; refundId?: string; disputeId?: string } },
): Promise<void> {
  const orgs = await eventOrganizers(c, event.id);
  const fees = await platformFeesAccount(c, order.currency);
  for (const share of shares) {
    const org = orgs.find((o) => o.organizer_id === share.organizer_id);
    if (!org) throw new Error(`organizer ${share.organizer_id} is not on event ${event.id}`);
    await postForOrganizer(
      c,
      `${keyBase}:fee:${org.organizer_id}`,
      { from: fees, to: creditBucket(event, org), amount: share.fee_cents, currency: order.currency },
      { organizerId: org.organizer_id, kind: "fee_returned", memo: posting.feeMemo, ctx: { eventId: event.id, ...posting.ctx } },
    );
    await debitOrganizer(c, `${keyBase}:${org.organizer_id}`, org, event.id, share.gross_cents, to, order.currency, {
      kind: posting.kind,
      memo: posting.memo,
      ctx: posting.ctx,
    });
  }
}

// ---- Stripe ------------------------------------------------------------------

export type ProviderRefundStatus = "pending" | "succeeded" | "failed" | "canceled" | "requires_action";

/** What the refund flow needs from Stripe. Faked in tests and in the demo. */
export interface RefundGateway {
  createRefund(
    input: { paymentIntentId: string; amountCents: number; refundId: string; orderId: string },
    idempotencyKey: string,
  ): Promise<{ id: string; status: ProviderRefundStatus; failure_reason?: string | null }>;
  getRefund(id: string): Promise<{ id: string; status: ProviderRefundStatus; failure_reason?: string | null }>;
}

/** Stripe said no for good (e.g. the charge is already fully refunded). Retrying cannot help. */
export class RefundRejectedError extends Error {}

export function stripeRefundGateway(secretKey: string): RefundGateway {
  assertTestModeKey(secretKey);
  const stripe = new Stripe(secretKey);
  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError) throw new RefundRejectedError(err.message);
      throw err;
    }
  };
  return {
    createRefund: (input, idempotencyKey) =>
      wrap(async () => {
        const r = await stripe.refunds.create(
          {
            payment_intent: input.paymentIntentId,
            amount: input.amountCents,
            metadata: { refund_id: input.refundId, order_id: input.orderId },
          },
          { idempotencyKey, timeout: 20_000 },
        );
        return { id: r.id, status: (r.status ?? "pending") as ProviderRefundStatus, failure_reason: r.failure_reason ?? null };
      }),
    getRefund: (id) =>
      wrap(async () => {
        const r = await stripe.refunds.retrieve(id, {}, { timeout: 20_000 });
        return { id: r.id, status: (r.status ?? "pending") as ProviderRefundStatus, failure_reason: r.failure_reason ?? null };
      }),
  };
}

/** For DEMO_MODE without a Stripe key: refunds of demo payments succeed at once. */
export function demoRefundGateway(): RefundGateway {
  const known = new Map<string, string>();
  return {
    async createRefund(_input, idempotencyKey) {
      const id = known.get(idempotencyKey) ?? `re_demo_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      known.set(idempotencyKey, id);
      return { id, status: "succeeded" };
    },
    async getRefund(id) {
      return { id, status: "succeeded" };
    },
  };
}

/**
 * Apply what Stripe says about a refund. Only moves forward from `pending`:
 *   succeeded  Refunds in flight → Refunded through Stripe. Done.
 *   failed     the customer did not get the money. It stays in "Refunds in
 *              flight" and the refund goes to requires_review: a person
 *              decides whether to retry it or give the money back to the
 *              organizer. Code does not guess.
 */
export async function applyRefundState(
  c: pg.PoolClient,
  refundId: string,
  provider: { id: string; status: ProviderRefundStatus; failure_reason?: string | null },
): Promise<RefundStatus | "no_change"> {
  const { rows } = await c.query<RefundRow>(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
  const refund = rows[0];
  if (!refund) throw new Error(`refund ${refundId} does not exist`);
  await c.query("UPDATE refunds SET stripe_refund_id = COALESCE(stripe_refund_id, $2), updated_at = now() WHERE id = $1", [
    refundId,
    provider.id,
  ]);
  if (refund.status !== "pending") return "no_change";
  if (provider.status === "succeeded") {
    const { transfer } = await createTransferInTx(
      c,
      `refund:${refund.id}:settle`,
      {
        from_account_id: await refundsInFlightAccount(c, refund.currency),
        to_account_id: await stripeRefundsAccount(c, refund.currency),
        amount_cents: refund.amount_cents,
        currency: refund.currency,
      },
      { scope: "system" },
    );
    if (transfer.status !== "posted") throw new Error(`could not settle refund ${refund.id}`);
    await c.query("UPDATE refunds SET status = 'succeeded', updated_at = now() WHERE id = $1", [refund.id]);
  } else if (provider.status === "failed" || provider.status === "canceled") {
    await c.query("UPDATE refunds SET status = 'requires_review', failure_reason = $2, updated_at = now() WHERE id = $1", [
      refund.id,
      `stripe: ${provider.status}${provider.failure_reason ? ` (${provider.failure_reason})` : ""}`,
    ]);
  } else {
    return "no_change";
  }
  const status = provider.status === "succeeded" ? "succeeded" : "requires_review";
  await enqueueOutboxEvent(c, {
    eventType: `refund.${status}`,
    aggregateType: "refund",
    aggregateId: refund.id,
    payload: { id: refund.id, order_id: refund.order_id, amount_cents: refund.amount_cents, status, stripe_refund_id: provider.id },
  });
  return status;
}

/**
 * The outbox publisher for `refund.submit`: asks Stripe to refund. Like the
 * payout submitter, every attempt uses the same idempotency key, refund:<id>,
 * so a retry after a lost response cannot refund the customer twice. A
 * refund Stripe still has as pending is asked about again on the next attempt
 * (the worker's backoff paces it).
 */
export function refundSubmitter(pool: pg.Pool, gateway: RefundGateway): Publisher {
  return {
    async publish(event) {
      const { refund_id } = event.payload as { refund_id: string };
      const refund = await getRefund(pool, refund_id);
      if (!refund) throw new PermanentPublishError(`refund ${refund_id} does not exist`);
      if (refund.status !== "pending") return;
      const { rows } = await pool.query<{ stripe_payment_intent_id: string | null }>(
        "SELECT stripe_payment_intent_id FROM orders WHERE id = $1",
        [refund.order_id],
      );
      const paymentIntent = rows[0]?.stripe_payment_intent_id;
      let result;
      try {
        result = refund.stripe_refund_id
          ? await gateway.getRefund(refund.stripe_refund_id)
          : await gateway.createRefund(
              { paymentIntentId: paymentIntent ?? "", amountCents: refund.amount_cents, refundId: refund.id, orderId: refund.order_id },
              `refund:${refund.id}`,
            );
      } catch (err) {
        if (err instanceof RefundRejectedError) {
          await withTransaction(pool, (c) => applyRefundState(c, refund.id, { id: refund.stripe_refund_id ?? `rejected:${refund.id}`, status: "failed", failure_reason: err.message }));
          return;
        }
        throw err; // outcome unknown: retry with the same key
      }
      const outcome = await withTransaction(pool, (c) => applyRefundState(c, refund.id, result));
      if (outcome === "no_change" && result.status !== "succeeded") {
        throw new Error(`Stripe has refund ${result.id} as ${result.status}; asking again later`);
      }
    },
  };
}
