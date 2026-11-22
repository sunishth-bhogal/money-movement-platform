import type pg from "pg";
import { eventOrganizers, releaseDueAt, type EventRow } from "./catalog.js";
import { organizerOverview } from "./statement.js";

/** Events a customer can buy tickets for, with what is left of each ticket type. */
export async function boxOfficeEvents(pool: pg.Pool, now = new Date()) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.venue, e.currency, e.starts_at, e.ends_at,
            (SELECT json_agg(o.name ORDER BY eo.share_bps DESC, o.id) FROM event_organizers eo JOIN organizers o ON o.id = eo.organizer_id
              WHERE eo.event_id = e.id) AS organizers,
            (SELECT json_agg(json_build_object('id', tt.id, 'name', tt.name, 'price_cents', tt.price_cents, 'capacity', tt.capacity,
                     'left', tt.capacity - (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status IN ('reserved', 'valid')))
                     ORDER BY tt.price_cents, tt.name)
               FROM ticket_types tt WHERE tt.event_id = e.id) AS ticket_types
       FROM events e
      WHERE e.status = 'on_sale' AND e.ends_at > $1
      ORDER BY e.starts_at, e.id`,
    [now],
  );
  return rows;
}

/** What a buyer may see of their order (by its unguessable id): no other buyer's details, no ledger. */
export async function publicOrder(pool: pg.Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.amount_cents, o.currency, o.buyer_name, o.created_at, o.paid_at,
            json_build_object('id', e.id, 'name', e.name, 'starts_at', e.starts_at, 'status', e.status, 'cancel_reason', e.cancel_reason) AS event,
            (SELECT json_agg(json_build_object('id', t.id, 'type', tt.name, 'price_cents', t.price_cents, 'status', t.status,
                     'refunded_cents', t.refunded_cents) ORDER BY tt.price_cents, t.id)
               FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = o.id) AS tickets,
            COALESCE((SELECT json_agg(json_build_object('amount_cents', r.amount_cents, 'status', r.status, 'reason', r.reason,
                     'created_at', r.created_at) ORDER BY r.created_at) FROM refunds r WHERE r.order_id = o.id), '[]') AS refunds
       FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
    [id],
  );
  return rows[0];
}

/** An organizer's events, with what each has sold and where its money is. */
export async function organizerEvents(pool: pg.Pool, organizerId: string) {
  const { rows } = await pool.query<
    EventRow & { share_bps: number; tickets_sold: number; gross_cents: number; refunded_cents: number; orders: number; co_hosts: string[] }
  >(
    `SELECT e.*, eo.share_bps,
            (SELECT count(*)::int FROM tickets t WHERE t.event_id = e.id AND t.status IN ('valid', 'refunded')) AS tickets_sold,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS gross_cents,
            (SELECT COALESCE(SUM(r.amount_cents), 0)::bigint FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = e.id) AS refunded_cents,
            (SELECT count(*)::int FROM orders o WHERE o.event_id = e.id AND o.status = 'paid') AS orders,
            (SELECT COALESCE(array_agg(o2.name ORDER BY o2.name), '{}') FROM event_organizers eo2 JOIN organizers o2 ON o2.id = eo2.organizer_id
              WHERE eo2.event_id = e.id AND eo2.organizer_id <> $1) AS co_hosts
       FROM events e JOIN event_organizers eo ON eo.event_id = e.id
      WHERE eo.organizer_id = $1
      ORDER BY e.starts_at DESC, e.id`,
    [organizerId],
  );
  return rows.map((e) => ({ ...e, release_due_at: releaseDueAt(e) }));
}

export async function isEventOrganizer(pool: pg.Pool, eventId: string, organizerId: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM event_organizers WHERE event_id = $1 AND organizer_id = $2", [eventId, organizerId]);
  return (rowCount ?? 0) > 0;
}

/** One event as its organizer sees it: ticket types, and every order with its tickets, refunds and chargebacks. */
export async function eventDetail(pool: pg.Pool, eventId: string) {
  const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [eventId]);
  if (!rows[0]) return undefined;
  const event = rows[0] as EventRow;
  const organizers = (await eventOrganizers(pool, eventId)).map((o) => ({ organizer_id: o.organizer_id, name: o.name, share_bps: o.share_bps }));
  const { rows: types } = await pool.query(
    `SELECT tt.id, tt.name, tt.price_cents, tt.capacity,
            (SELECT count(*)::int FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status IN ('reserved', 'valid')) AS taken
       FROM ticket_types tt WHERE tt.event_id = $1 ORDER BY tt.price_cents, tt.name`,
    [eventId],
  );
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, o.amount_cents, o.fee_cents, o.currency, o.status, o.created_at, o.paid_at,
            (SELECT json_agg(json_build_object('id', t.id, 'type', tt.name, 'price_cents', t.price_cents, 'status', t.status,
                     'refunded_cents', t.refunded_cents) ORDER BY tt.price_cents, t.id)
               FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = o.id) AS tickets,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM refunds r WHERE r.order_id = o.id) AS refunded_cents,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM disputes d WHERE d.order_id = o.id AND d.status <> 'won') AS disputed_cents
       FROM orders o WHERE o.event_id = $1 AND o.status NOT IN ('created')
      ORDER BY o.created_at DESC, o.id`,
    [eventId],
  );
  return { event: { ...event, release_due_at: releaseDueAt(event) }, organizers, ticket_types: types, orders };
}

/**
 * The audit trail of one order, from one organizer's side: the payment, its
 * tickets, refunds and chargebacks, and every ledger transfer behind them,
 * each with its entries and the posting that explains it.
 */
export async function orderTrace(pool: pg.Pool, orderId: string, organizerId?: string) {
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.event_id, o.buyer_name, o.buyer_email, o.amount_cents, o.fee_cents, o.currency, o.status,
            o.stripe_checkout_session_id, o.stripe_payment_intent_id, o.sale_shares, o.created_at, o.paid_at, e.name AS event_name
       FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
    [orderId],
  );
  if (!orders[0]) return undefined;
  const { rows: tickets } = await pool.query(
    `SELECT t.id, tt.name AS type, t.price_cents, t.fee_cents, t.status, t.refunded_cents
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = $1 ORDER BY tt.price_cents, t.id`,
    [orderId],
  );
  const { rows: refunds } = await pool.query(
    `SELECT id, ticket_id, amount_cents, reason, note, requested_by, status, stripe_refund_id, failure_reason, shares, created_at
       FROM refunds WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const { rows: disputes } = await pool.query(
    `SELECT id, stripe_dispute_id, amount_cents, fee_cents, reason, status, shares, created_at, closed_at FROM disputes WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  // Every transfer behind this order: its sale (order:<id>:...), its refunds and disputes (refund:<id>:..., dispute:<id>:...).
  const { rows: transfers } = await pool.query(
    `SELECT t.id, t.idempotency_key, t.amount_cents, t.currency, t.created_at,
            p.kind, p.organizer_id, p.memo,
            json_agg(json_build_object('account', a.name, 'amount_cents', e.amount_cents) ORDER BY e.id) AS entries
       FROM transfers t
       JOIN ledger_entries e ON e.transfer_id = t.id
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN organizer_postings p ON p.transfer_id = t.id
      WHERE t.idempotency_scope = 'system'
        AND (t.idempotency_key LIKE 'order:' || $1 || ':%'
             OR split_part(t.idempotency_key, ':', 2) IN (SELECT id::text FROM refunds WHERE order_id = $1 UNION ALL SELECT id::text FROM disputes WHERE order_id = $1))
        AND ($2::uuid IS NULL OR p.organizer_id IS NULL OR p.organizer_id = $2)
      GROUP BY t.id, p.kind, p.organizer_id, p.memo
      ORDER BY t.created_at, t.id`,
    [orderId, organizerId ?? null],
  );
  return { order: orders[0], tickets, refunds, disputes, transfers };
}

/** Every organizer with their balances (the operator's view). */
export async function organizersWithBalances(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.currency, right(o.bank_account_number, 4) AS bank_account_last4,
            h.balance_cents AS held_cents, a.balance_cents AS available_cents,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM payouts p WHERE p.organizer_id = o.id AND p.status IN ('pending', 'submitted')) AS in_flight_cents,
            (SELECT COALESCE(SUM(amount_cents), 0)::bigint FROM payouts p WHERE p.organizer_id = o.id AND p.status = 'succeeded') AS paid_out_cents
       FROM organizers o JOIN accounts h ON h.id = o.held_account_id JOIN accounts a ON a.id = o.available_account_id
      ORDER BY a.balance_cents, o.name`,
  );
  return rows;
}

/**
 * Invariants of the ticketing money. Empty means they hold. Tests run this
 * after every scenario; so can an operator.
 *  - a paid order's sale postings add up to what the customer paid
 *  - no order has more refunded and charged back than it was paid
 *  - nothing is held for a released or fully refunded cancelled event
 *  - "Refunds in flight" is exactly the refunds Stripe has not confirmed
 *  - every organizer's payout statements add up to their payouts, and the
 *    upcoming one to their current balance
 */
export async function checkEventInvariants(pool: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const { rows: sales } = await pool.query<{ id: string; amount_cents: number; sold: number }>(
    `SELECT o.id, o.amount_cents,
            COALESCE((SELECT SUM(e.amount_cents) FROM organizer_postings p JOIN ledger_entries e ON e.transfer_id = p.transfer_id
                       JOIN organizers g ON g.id = p.organizer_id AND e.account_id IN (g.held_account_id, g.available_account_id)
                      WHERE p.order_id = o.id AND p.kind = 'ticket_sale'), 0)::bigint AS sold
       FROM orders o WHERE o.status = 'paid'`,
  );
  for (const s of sales) if (s.sold !== s.amount_cents) problems.push(`order ${s.id}: paid ${s.amount_cents}, sale postings ${s.sold}`);

  const { rows: over } = await pool.query<{ id: string }>(
    `SELECT o.id FROM orders o
      WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds r WHERE r.order_id = o.id)
          + (SELECT COALESCE(SUM(LEAST(amount_cents, (SELECT SUM((x->>'gross_cents')::bigint) FROM jsonb_array_elements(d.shares) x))), 0)
               FROM disputes d WHERE d.order_id = o.id AND d.status <> 'won') > o.amount_cents`,
  );
  for (const o of over) problems.push(`order ${o.id}: refunded and charged back more than was paid`);

  const { rows: heldLeft } = await pool.query<{ event_id: string; organizer_id: string; held: number }>(
    `SELECT p.event_id, p.organizer_id, SUM(e.amount_cents)::bigint AS held
       FROM organizer_postings p
       JOIN organizers g ON g.id = p.organizer_id
       JOIN ledger_entries e ON e.transfer_id = p.transfer_id AND e.account_id = g.held_account_id
       JOIN events ev ON ev.id = p.event_id
      GROUP BY p.event_id, p.organizer_id, ev.released_at, ev.status
     HAVING SUM(e.amount_cents) < 0 OR (ev.released_at IS NOT NULL AND SUM(e.amount_cents) <> 0)`,
  );
  for (const h of heldLeft) problems.push(`event ${h.event_id}, organizer ${h.organizer_id}: ${h.held} held after release, or negative`);

  const { rows: rif } = await pool.query<{ balance: number; expected: number }>(
    `SELECT COALESCE((SELECT balance_cents FROM accounts WHERE system_code = 'refunds_in_flight' AND currency = 'USD'), 0)::bigint AS balance,
            COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE status <> 'succeeded' AND currency = 'USD'), 0)::bigint AS expected`,
  );
  if (rif[0].balance !== rif[0].expected) problems.push(`refunds in flight: balance ${rif[0].balance}, open refunds ${rif[0].expected}`);

  const { rows: orgs } = await pool.query<{ id: string }>("SELECT id FROM organizers");
  for (const o of orgs) {
    const overview = (await organizerOverview(pool, o.id))!;
    for (const s of overview.payouts) if (!s.balanced) problems.push(`organizer ${o.id}: statement for payout ${s.payout?.id} adds up to ${s.total_cents}, not ${s.payout?.amount_cents}`);
    if (!overview.upcoming.balanced) problems.push(`organizer ${o.id}: upcoming statement adds up to ${overview.upcoming.total_cents}, balance is ${overview.balances.available_cents}`);
    const heldTotal = overview.held.reduce((s, h) => s + h.held_cents, 0);
    if (heldTotal !== overview.balances.held_cents) problems.push(`organizer ${o.id}: held events add up to ${heldTotal}, held balance is ${overview.balances.held_cents}`);
  }
  return problems;
}
