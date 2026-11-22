import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import type { CheckoutGateway } from "../payments/stripe.js";
import { getEvent, lockEvent } from "./catalog.js";
import { remainingShares, ticketFee, type Share } from "./money.js";

export type OrderStatus = "created" | "pending" | "processing" | "paid" | "failed" | "expired" | "requires_review";

export interface Order {
  id: string;
  idempotency_key: string;
  event_id: string;
  buyer_name: string;
  buyer_email: string;
  currency: string;
  amount_cents: number;
  fee_cents: number;
  status: OrderStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  checkout_url: string | null;
  failure_reason: string | null;
  sale_shares: Share[] | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Ticket {
  id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  ticket_type: string;
  price_cents: number;
  fee_cents: number;
  status: "reserved" | "valid" | "released" | "refunded";
  refunded_cents: number;
}

export interface OrderRequest {
  event_id: string;
  buyer_name: string;
  buyer_email: string;
  items: { ticket_type_id: string; quantity: number }[];
}

export const ORDER_FINAL: ReadonlySet<OrderStatus> = new Set(["paid", "failed", "expired", "requires_review"]);

export const ORDER_COLUMNS =
  "id, idempotency_key, request_hash, event_id, buyer_name, buyer_email, currency, amount_cents, fee_cents, status, " +
  "stripe_checkout_session_id, stripe_payment_intent_id, checkout_url, failure_reason, sale_shares, paid_at, created_at, updated_at";

export type OrderRow = Order & { request_hash: string };

export function toOrder({ request_hash: _hash, ...o }: OrderRow): Order {
  return o;
}

function hashOrderRequest(req: OrderRequest): string {
  const items = [...req.items].sort((a, b) => a.ticket_type_id.localeCompare(b.ticket_type_id)).map((i) => [i.ticket_type_id, i.quantity]);
  return createHash("sha256")
    .update(JSON.stringify([req.event_id, req.buyer_name, req.buyer_email.toLowerCase(), items]))
    .digest("hex");
}

export async function getOrder(db: pg.Pool | pg.PoolClient, id: string): Promise<Order | undefined> {
  const { rows } = await db.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]);
  return rows[0] && toOrder(rows[0]);
}

export async function lockOrder(c: pg.PoolClient, id: string): Promise<Order | undefined> {
  const { rows } = await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] && toOrder(rows[0]);
}

export async function orderTickets(db: pg.Pool | pg.PoolClient, orderId: string): Promise<Ticket[]> {
  const { rows } = await db.query<Ticket>(
    `SELECT t.id, t.order_id, t.event_id, t.ticket_type_id, tt.name AS ticket_type, t.price_cents, t.fee_cents, t.status, t.refunded_cents
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.order_id = $1 ORDER BY tt.price_cents, t.created_at, t.id`,
    [orderId],
  );
  return rows;
}

/**
 * What of a paid order can still be taken back, per organizer: its sale,
 * minus every refund (whatever Stripe later says: the money already left the
 * organizer when it was created), minus every chargeback not won.
 */
export async function orderRemaining(c: pg.PoolClient | pg.Pool, order: Order): Promise<{ total: number; shares: Share[] }> {
  if (!order.sale_shares) return { total: 0, shares: [] };
  const { rows } = await c.query<{ shares: Share[] }>(
    `SELECT shares FROM refunds WHERE order_id = $1
     UNION ALL
     SELECT shares FROM disputes WHERE order_id = $1 AND status <> 'won'`,
    [order.id],
  );
  const shares = remainingShares(
    order.sale_shares,
    rows.map((r) => r.shares),
  );
  return { total: shares.reduce((sum, s) => sum + s.gross_cents, 0), shares };
}

/**
 * Start a ticket order: reserve the seats, then open a Stripe Checkout session.
 *
 * The same two steps as a deposit, for the same reason (a Stripe call cannot
 * sit inside a Postgres transaction):
 *
 *  1. One transaction, under the event's lock: check the event is on sale and
 *     each ticket type has room, insert the order and one reserved ticket per
 *     seat. Keyed by the buyer's Idempotency-Key, so a retried "Buy" click
 *     returns this order instead of reserving more seats.
 *  2. Call Stripe with the key order-checkout:<id>, then save the session.
 *
 * No money moves here. The ledger is touched only when the verified webhook
 * says the payment succeeded.
 */
export async function createOrder(
  pool: pg.Pool,
  gateway: CheckoutGateway,
  idempotencyKey: string,
  req: OrderRequest,
  returnUrl: string,
): Promise<{ order: Order; replayed: boolean }> {
  const requestHash = hashOrderRequest(req);
  const { row, replayed } = await withTransaction(pool, async (c) => {
    const { rows: existing } = await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    if (existing[0]) return { row: existing[0], replayed: true };

    const event = await lockEvent(c, req.event_id);
    if (event.status !== "on_sale") throw new ApiError(409, "event_cancelled", "This event was cancelled.");
    if (event.ends_at.getTime() <= Date.now()) throw new ApiError(409, "sales_closed", "This event has ended.");

    const merged = new Map<string, number>();
    for (const item of req.items) merged.set(item.ticket_type_id, (merged.get(item.ticket_type_id) ?? 0) + item.quantity);

    const { rows: types } = await c.query<{ id: string; name: string; price_cents: number; capacity: number; taken: number }>(
      `SELECT tt.id, tt.name, tt.price_cents, tt.capacity,
              (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status IN ('reserved', 'valid'))::int AS taken
         FROM ticket_types tt WHERE tt.event_id = $1 AND tt.id = ANY($2::uuid[])`,
      [event.id, [...merged.keys()]],
    );
    if (types.length !== merged.size) throw new ApiError(404, "ticket_type_not_found", "A ticket type does not belong to this event.");

    let amount = 0;
    let fee = 0;
    const seats: { typeId: string; price: number; fee: number }[] = [];
    for (const t of types) {
      const quantity = merged.get(t.id)!;
      if (t.taken + quantity > t.capacity) {
        throw new ApiError(409, "sold_out", `Only ${Math.max(0, t.capacity - t.taken)} ${t.name} left.`);
      }
      const perTicketFee = ticketFee(t.price_cents, event.fee_bps, event.fee_fixed_cents);
      for (let i = 0; i < quantity; i++) seats.push({ typeId: t.id, price: t.price_cents, fee: perTicketFee });
      amount += t.price_cents * quantity;
      fee += perTicketFee * quantity;
    }

    const { rows: inserted } = await c.query<OrderRow>(
      `INSERT INTO orders (idempotency_key, request_hash, event_id, buyer_name, buyer_email, currency, amount_cents, fee_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ORDER_COLUMNS}`,
      [idempotencyKey, requestHash, event.id, req.buyer_name, req.buyer_email, event.currency, amount, fee],
    );
    if (!inserted[0]) {
      const { rows } = await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = $1`, [idempotencyKey]);
      return { row: rows[0], replayed: true };
    }
    for (const s of seats) {
      await c.query(
        "INSERT INTO tickets (order_id, event_id, ticket_type_id, price_cents, fee_cents) VALUES ($1, $2, $3, $4, $5)",
        [inserted[0].id, event.id, s.typeId, s.price, s.fee],
      );
    }
    return { row: inserted[0], replayed: false };
  });

  if (row.request_hash !== requestHash) {
    throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
  }
  if (row.status !== "created") return { order: toOrder(row), replayed };

  const event = (await getEvent(pool, row.event_id))!;
  const { rows: lines } = await pool.query<{ name: string; price_cents: number; quantity: number }>(
    `SELECT tt.name, t.price_cents, count(*)::int AS quantity
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.order_id = $1 GROUP BY tt.name, t.price_cents ORDER BY t.price_cents, tt.name`,
    [row.id],
  );
  let session: { id: string; url: string };
  try {
    session = await gateway.createCheckoutSession(
      {
        reference: { type: "order", id: row.id },
        lineItems: lines.map((l) => ({ name: `${event.name}: ${l.name}`, unitAmountCents: l.price_cents, quantity: l.quantity })),
        currency: row.currency,
        successUrl: `${returnUrl}?order=${row.id}&checkout=success`,
        cancelUrl: `${returnUrl}?order=${row.id}&checkout=cancelled`,
      },
      `order-checkout:${row.id}`,
    );
  } catch (err) {
    throw new ApiError(502, "payment_provider_error", `Could not create a Stripe Checkout session: ${(err as Error).message}`);
  }
  await pool.query(
    `UPDATE orders
        SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2),
            checkout_url = $3,
            status = CASE WHEN status = 'created' THEN 'pending' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [row.id, session.id, session.url],
  );
  return { order: (await getOrder(pool, row.id))!, replayed };
}
