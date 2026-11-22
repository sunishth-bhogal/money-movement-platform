import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBank } from "../src/bank/mockBank.js";
import { BANK_SIGNATURE_HEADER, signBankWebhook } from "../src/bank/signature.js";
import { withTransaction } from "../src/db.js";
import { createEvent, createOrganizer } from "../src/events/catalog.js";
import { runPayoutSchedule } from "../src/events/lifecycle.js";
import { allocate, reductionShares, saleShares, ticketFee } from "../src/events/money.js";
import { checkEventInvariants } from "../src/events/queries.js";
import { refundSubmitter, type RefundGateway } from "../src/events/refunds.js";
import { organizerOverview } from "../src/events/statement.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { createTransferInTx } from "../src/ledger/transfers.js";
import { routingPublisher } from "../src/outbox/publishers.js";
import { OutboxWorker } from "../src/outbox/worker.js";
import { referenceMetadata, type CheckoutSessionInput, type StripeSessionRecord } from "../src/payments/stripe.js";
import { checkPayoutInvariants, PAYOUT_SUBMIT_EVENT } from "../src/payouts/payouts.js";
import { payoutSubmitter } from "../src/payouts/submitter.js";
import { runReconciliation } from "../src/reconciliation/run.js";
import { issueSessionToken } from "../src/wallet/auth.js";
import { OPERATOR_TOKEN, pool } from "./helpers.js";

const WEBHOOK_SECRET = "whsec_test_" + randomUUID().replaceAll("-", "");
const BANK_SECRET = "test_bank_secret_events";
const SESSION_SECRET = "test-session-secret-events";
const AUTH = { authorization: `Bearer ${OPERATOR_TOKEN}` };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Mock bank account numbers (see src/bank/mockBank.ts).
const PAYS = "000999881111";
const FAILS_LATER = "000999880002";

/** Stripe's Checkout, as far as orders see it: a session per order, listed for reconciliation. */
class FakeStripe {
  sessions = new Map<string, StripeSessionRecord>();
  checkoutCalls = 0;
  async createCheckoutSession(input: CheckoutSessionInput, key: string) {
    this.checkoutCalls++;
    const id = `cs_test_${key.split(":")[1].replaceAll("-", "")}`;
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        client_reference_id: input.reference.id,
        metadata: referenceMetadata(input.reference),
        status: "open",
        payment_status: "unpaid",
        amount_total: input.lineItems.reduce((s, l) => s + l.unitAmountCents * l.quantity, 0),
        currency: input.currency.toLowerCase(),
        payment_intent: null,
        created: Math.floor(Date.now() / 1000),
      });
    }
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }
  async listCheckoutSessions() {
    return { data: [...this.sessions.values()], has_more: false };
  }
}

/** Stripe's refunds: succeed, unless told to fail. */
class FakeRefunds implements RefundGateway {
  calls: string[] = [];
  outcome: "succeeded" | "failed" = "succeeded";
  async createRefund(_input: { amountCents: number }, key: string) {
    this.calls.push(key);
    return { id: `re_${key.replaceAll(":", "_")}`, status: this.outcome };
  }
  async getRefund(id: string) {
    return { id, status: this.outcome };
  }
}

let stripe: FakeStripe;
let refunds: FakeRefunds;
let bank: MockBank;
let clock: number;

const app = buildApp(pool, {
  admin: { token: OPERATOR_TOKEN, providers: {} },
  wallet: { sessionSecret: SESSION_SECRET },
  bankWebhookSecret: BANK_SECRET,
  payments: {
    gateway: { createCheckoutSession: (i, k) => stripe.createCheckoutSession(i, k) },
    records: { listCheckoutSessions: () => stripe.listCheckoutSessions() },
    webhookSecret: WEBHOOK_SECRET,
    appBaseUrl: "http://localhost:3000",
  },
});

function makeWorker() {
  return new OutboxWorker(
    pool,
    routingPublisher(
      { [PAYOUT_SUBMIT_EVENT]: payoutSubmitter(pool, bank), "refund.submit": refundSubmitter(pool, refunds) },
      { async publish() {} },
    ),
    { leaseMs: 5_000, publishTimeoutMs: 1_000, baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 50 },
  );
}
let worker: OutboxWorker;

beforeEach(async () => {
  // Earlier test files leave events behind; settle them so we only drive ours.
  await pool.query("UPDATE outbox SET status = 'published', published_at = now(), claim_token = NULL WHERE status <> 'published'");
  stripe = new FakeStripe();
  refunds = new FakeRefunds();
  clock = Date.now();
  bank = new MockBank({
    now: () => clock,
    behaviour: { settleAfterMs: 1_000 },
    deliver: async (event) => {
      const body = JSON.stringify(event);
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/bank",
        headers: { "content-type": "application/json", [BANK_SIGNATURE_HEADER]: signBankWebhook(BANK_SECRET, body) },
        payload: body,
      });
      if (res.statusCode !== 200) throw new Error(`bank webhook answered ${res.statusCode}`);
    },
  });
  worker = makeWorker();
});

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
  expect(await checkPayoutInvariants(pool)).toEqual([]);
  expect(await checkEventInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

// ---- helpers ------------------------------------------------------------------

async function organizer(name: string, bankAccount = PAYS) {
  return createOrganizer(pool, { name: `${name} ${randomUUID().slice(0, 6)}`, currency: "USD", bank_account_number: bankAccount });
}

async function event(opts: {
  organizers: [string, number][];
  price?: number;
  capacity?: number;
  advance_bps?: number;
  startsInHours?: number;
}) {
  const starts = new Date(Date.now() + (opts.startsInHours ?? 72) * 3_600_000);
  const e = await createEvent(pool, {
    name: `Event ${randomUUID().slice(0, 6)}`,
    currency: "USD",
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + 3 * 3_600_000).toISOString(),
    fee_bps: 500,
    fee_fixed_cents: 50,
    hold_hours: 24,
    advance_bps: opts.advance_bps ?? 0,
    organizers: opts.organizers.map(([organizer_id, share_bps]) => ({ organizer_id, share_bps })),
    ticket_types: [{ name: "General admission", price_cents: opts.price ?? 2500, capacity: opts.capacity ?? 100 }],
  });
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM ticket_types WHERE event_id = $1", [e.id]);
  return { ...e, ticketTypeId: rows[0].id };
}

function buyRequest(eventId: string, ticketTypeId: string, quantity: number, key = randomUUID(), buyer = "Sam Buyer") {
  return app.inject({
    method: "POST",
    url: `/box-office/events/${eventId}/orders`,
    headers: { "idempotency-key": key },
    payload: { buyer_name: buyer, buyer_email: "sam@example.test", items: [{ ticket_type_id: ticketTypeId, quantity }] },
  });
}

async function order(orderId: string) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  return rows[0] as { id: string; amount_cents: number; stripe_checkout_session_id: string; status: string; stripe_payment_intent_id: string };
}

/** Stripe delivers a signed event to our webhook. */
async function stripeWebhook(type: string, object: Record<string, unknown>, eventId = `evt_${randomUUID().replaceAll("-", "")}`) {
  const payload = JSON.stringify({ id: eventId, object: "event", api_version: Stripe.API_VERSION, created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
    payload,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string };
}

function paidSession(o: { id: string; amount_cents: number; stripe_checkout_session_id: string }) {
  return {
    id: o.stripe_checkout_session_id,
    object: "checkout.session",
    client_reference_id: o.id,
    metadata: { order_id: o.id },
    payment_status: "paid",
    status: "complete",
    amount_total: o.amount_cents,
    currency: "usd",
    payment_intent: `pi_${o.id.replaceAll("-", "").slice(0, 20)}`,
  };
}

/** Buy and pay: the order is paid once the webhook arrives. */
async function sell(eventId: string, ticketTypeId: string, quantity: number, buyer = "Sam Buyer") {
  const res = await buyRequest(eventId, ticketTypeId, quantity, randomUUID(), buyer);
  expect(res.statusCode).toBe(201);
  const o = await order(res.json().order.id);
  expect((await stripeWebhook("checkout.session.completed", paidSession(o))).outcome).toBe("order_paid");
  return order(o.id);
}

async function balances(org: { held_account_id: string; available_account_id: string }) {
  const { rows } = await pool.query<{ id: string; balance_cents: number }>("SELECT id, balance_cents FROM accounts WHERE id = ANY($1::uuid[])", [
    [org.held_account_id, org.available_account_id],
  ]);
  const get = (id: string) => rows.find((r) => r.id === id)!.balance_cents;
  return { held: get(org.held_account_id), available: get(org.available_account_id) };
}

const systemBalance = async (code: string) =>
  (await pool.query<{ b: number }>("SELECT COALESCE((SELECT balance_cents FROM accounts WHERE system_code = $1 AND currency = 'USD'), 0)::bigint AS b", [code]))
    .rows[0].b;

/** The event happened (and its hold period passed): the payout schedule releases and pays it. */
async function finish(eventId: string) {
  await pool.query(
    "UPDATE events SET starts_at = now() - interval '5 hours', ends_at = now() - interval '2 hours', hold_hours = 0 WHERE id = $1",
    [eventId],
  );
  return runPayoutSchedule(pool);
}

/** Run the outbox until nothing of ours is pending (payout submits, refund submits). */
async function drain() {
  for (let i = 0; i < 100; i++) {
    await worker.drain();
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE status = 'pending' AND event_type IN ('payout.submit', 'refund.submit') AND next_attempt_at <= now()",
    );
    if (rows[0].n === 0) return;
    await sleep(5);
  }
}

async function settleBank() {
  clock += 2_000;
  await bank.processDue();
}

const organizerToken = (id: string) => issueSessionToken(SESSION_SECRET, `organizer:${id}`).token;
const asOrganizer = (id: string) => ({ authorization: `Bearer ${organizerToken(id)}` });

// ---- the arithmetic -------------------------------------------------------------

describe("splitting money to the cent", () => {
  it("allocate always adds up exactly, respects caps, and is deterministic", () => {
    expect(allocate(100, [{ weight: 1 }, { weight: 1 }, { weight: 1 }])).toEqual([34, 33, 33]);
    expect(allocate(7, [{ weight: 6000 }, { weight: 4000 }])).toEqual([4, 3]);
    expect(allocate(10, [{ weight: 9, cap: 5 }, { weight: 1 }])).toEqual([5, 5]);
    for (let i = 0; i < 200; i++) {
      const amount = Math.floor(Math.random() * 1_000_000);
      const parts = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({ weight: 1 + Math.floor(Math.random() * 10_000) }));
      expect(allocate(amount, parts).reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });

  it("the fee is 5% + $0.50 a ticket, and a split's fee never exceeds what each organizer sold", () => {
    expect(ticketFee(2500, 500, 50)).toBe(175);
    expect(ticketFee(30, 500, 50)).toBe(30); // never more than the price
    const shares = saleShares(7500, 525, [
      { organizer_id: "a", share_bps: 6000 },
      { organizer_id: "b", share_bps: 4000 },
    ]);
    expect(shares).toEqual([
      { organizer_id: "a", gross_cents: 4500, fee_cents: 315 },
      { organizer_id: "b", gross_cents: 3000, fee_cents: 210 },
    ]);
  });

  it("partial refunds return the fee proportionally, never more than was charged, and all of it on the last one", () => {
    let remaining = [{ organizer_id: "a", gross_cents: 2500, fee_cents: 175 }];
    let feeBack = 0;
    for (const amount of [333, 1, 999, 1167]) {
      const [s] = reductionShares(amount, remaining);
      feeBack += s.fee_cents;
      remaining = [{ organizer_id: "a", gross_cents: remaining[0].gross_cents - s.gross_cents, fee_cents: remaining[0].fee_cents - s.fee_cents }];
      expect(feeBack).toBeLessThanOrEqual(175);
    }
    expect(remaining[0]).toEqual({ organizer_id: "a", gross_cents: 0, fee_cents: 0 });
    expect(feeBack).toBe(175);
  });
});

// ---- selling ------------------------------------------------------------------

describe("selling tickets", () => {
  it("a paid order credits each co-host their share minus their share of the fee, held until the event", async () => {
    const a = await organizer("Northside");
    const b = await organizer("Lakeview");
    const e = await event({ organizers: [[a.id, 6000], [b.id, 4000]] });
    const feesBefore = await systemBalance("platform_fees");
    const clearingBefore = await systemBalance("stripe_clearing");

    const o = await sell(e.id, e.ticketTypeId, 3); // 3 × $25.00, fee 3 × $1.75
    expect(o.amount_cents).toBe(7500);
    expect(await balances(a)).toEqual({ held: 4500 - 315, available: 0 });
    expect(await balances(b)).toEqual({ held: 3000 - 210, available: 0 });
    expect((await systemBalance("platform_fees")) - feesBefore).toBe(525);
    expect((await systemBalance("stripe_clearing")) - clearingBefore).toBe(-7500);
    const { rows } = await pool.query("SELECT status FROM tickets WHERE order_id = $1", [o.id]);
    expect(rows.map((r) => r.status)).toEqual(["valid", "valid", "valid"]);
  });

  it("the same payment webhook twice, or a second event for the same payment, credits it once", async () => {
    const a = await organizer("Dupes");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const res = await buyRequest(e.id, e.ticketTypeId, 2);
    const o = await order(res.json().order.id);
    const evtId = `evt_${randomUUID().replaceAll("-", "")}`;
    expect((await stripeWebhook("checkout.session.completed", paidSession(o), evtId)).outcome).toBe("order_paid");
    expect((await stripeWebhook("checkout.session.completed", paidSession(o), evtId)).outcome).toBe("duplicate");
    expect((await stripeWebhook("checkout.session.async_payment_succeeded", paidSession(o))).outcome).toBe("already_final");
    expect((await balances(a)).held).toBe(5000 - 350);
  });

  it("a retried Buy click returns the same order and one Checkout session", async () => {
    const a = await organizer("Retry");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const key = randomUUID();
    const [r1, r2] = await Promise.all([buyRequest(e.id, e.ticketTypeId, 2, key), buyRequest(e.id, e.ticketTypeId, 2, key)]);
    expect(r1.json().order.id).toBe(r2.json().order.id);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tickets WHERE event_id = $1", [e.id]);
    expect(rows[0].n).toBe(2);
    expect((await buyRequest(e.id, e.ticketTypeId, 3, key)).statusCode).toBe(422); // same key, different order
  });

  it("two buyers racing for the last seat: one gets it, the other is told it sold out", async () => {
    const a = await organizer("Capacity");
    const e = await event({ organizers: [[a.id, 10_000]], capacity: 1 });
    const results = await Promise.all([buyRequest(e.id, e.ticketTypeId, 1), buyRequest(e.id, e.ticketTypeId, 1)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("sold_out");
  });

  it("an abandoned checkout releases its seats", async () => {
    const a = await organizer("Abandon");
    const e = await event({ organizers: [[a.id, 10_000]], capacity: 2 });
    const o = await order((await buyRequest(e.id, e.ticketTypeId, 2)).json().order.id);
    expect((await buyRequest(e.id, e.ticketTypeId, 1)).statusCode).toBe(409);
    await stripeWebhook("checkout.session.expired", { ...paidSession(o), payment_status: "unpaid", status: "expired" });
    expect((await buyRequest(e.id, e.ticketTypeId, 1)).statusCode).toBe(201);
  });
});

// ---- refunds and payouts ----------------------------------------------------------

describe("refunds, release and payout", () => {
  it("a partial refund of one ticket comes out of held proceeds, returns its share of the fee, and settles when Stripe confirms", async () => {
    const a = await organizer("Partial");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const o = await sell(e.id, e.ticketTypeId, 2);
    const { rows: tickets } = await pool.query<{ id: string }>("SELECT id FROM tickets WHERE order_id = $1 ORDER BY id", [o.id]);
    const before = await systemBalance("stripe_refunds");

    const res = await app.inject({
      method: "POST",
      url: `/organizer/orders/${o.id}/refunds`,
      headers: { ...asOrganizer(a.id), "idempotency-key": randomUUID() },
      payload: { ticket_id: tickets[0].id, amount_cents: 1000, reason: "requested_by_customer", note: "blocked view" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().refund).toMatchObject({ amount_cents: 1000, status: "pending" });
    // $10 refunded, $0.70 of the $3.50 fee comes back with it (1000/5000 of the order's fee).
    expect((await balances(a)).held).toBe(5000 - 350 - 1000 + 70);

    await drain();
    expect(refunds.calls).toEqual([`refund:${res.json().refund.id}`]);
    expect((await pool.query("SELECT status FROM refunds WHERE id = $1", [res.json().refund.id])).rows[0].status).toBe("succeeded");
    expect((await systemBalance("stripe_refunds")) - before).toBe(1000);

    // More than is left on that ticket is refused.
    const tooMuch = await app.inject({
      method: "POST",
      url: `/organizer/orders/${o.id}/refunds`,
      headers: { ...asOrganizer(a.id), "idempotency-key": randomUUID() },
      payload: { ticket_id: tickets[0].id, amount_cents: 1501, reason: "requested_by_customer" },
    });
    expect(tooMuch.json().error.code).toBe("amount_too_large");
  });

  it("after the event, the schedule releases held money and pays each organizer once; the statement explains it to the cent", async () => {
    const a = await organizer("Release A");
    const b = await organizer("Release B");
    const e = await event({ organizers: [[a.id, 6000], [b.id, 4000]] });
    await sell(e.id, e.ticketTypeId, 3);
    await sell(e.id, e.ticketTypeId, 1);

    const released = await finish(e.id);
    expect(released.find((r) => r.event_id === e.id)!.organizers.map((o) => o.payout?.amount_cents)).toEqual([5580, 3720]);
    expect(await runPayoutSchedule(pool)).toEqual([]); // again: nothing
    expect(await balances(a)).toEqual({ held: 0, available: 0 });

    await drain();
    await settleBank();
    const { rows } = await pool.query("SELECT status FROM payouts WHERE organizer_id = $1", [a.id]);
    expect(rows).toEqual([{ status: "succeeded" }]);

    const overview = (await organizerOverview(pool, a.id))!;
    const [statement] = overview.payouts;
    expect(statement.balanced).toBe(true);
    expect(statement.total_cents).toBe(5580);
    const lines = Object.fromEntries(statement.sections[0].lines.map((l) => [l.kind, [l.amount_cents, l.count]]));
    expect(lines).toEqual({ ticket_sale: [6000, 4], platform_fee: [-420, 2] });
    expect(statement.summary[0]).toBe("You sold $60.00 in tickets (4 tickets).");
    expect(statement.summary.at(-1)).toBe("So this payout is $55.80.");
  });

  it("a chargeback after payout makes the organizer owe it, and their next payout is smaller by exactly that, with the reason", async () => {
    const a = await organizer("Chargeback");
    const first = await event({ organizers: [[a.id, 10_000]] });
    const second = await event({ organizers: [[a.id, 10_000]] });
    const disputed = await sell(first.id, first.ticketTypeId, 2, "Dee Spute"); // $50.00, net $46.50
    await finish(first.id);
    await drain();
    await settleBank();

    await stripeWebhook("charge.dispute.created", {
      id: `dp_${randomUUID().slice(0, 8)}`,
      object: "dispute",
      amount: 5000,
      currency: "usd",
      payment_intent: disputed.stripe_payment_intent_id,
      status: "needs_response",
      reason: "fraudulent",
    });
    // −$50.00 chargeback, +$3.50 fee returned, −$15.00 chargeback fee.
    expect((await balances(a)).available).toBe(-5000 + 350 - 1500);
    const owing = (await organizerOverview(pool, a.id))!;
    expect(owing.balances.owed_by_organizer_cents).toBe(6150);
    expect(owing.upcoming.summary.at(-1)).toBe("So you owe $61.50. It comes out of your next payout before anything is paid to you.");

    await sell(second.id, second.ticketTypeId, 4); // $100.00, net $93.00
    const [release] = await finish(second.id);
    expect(release.organizers[0].payout!.amount_cents).toBe(9300 - 6150);

    const statement = (await organizerOverview(pool, a.id))!.payouts[0];
    expect(statement.balanced).toBe(true);
    expect(statement.sections.map((s) => s.title)).toEqual([
      expect.stringContaining("released after the event"),
      expect.stringContaining("after it was paid out"),
    ]);
    const after = statement.sections[1];
    expect(after.event!.id).toBe(first.id);
    expect(after.lines.map((l) => [l.kind, l.amount_cents])).toEqual([
      ["fee_returned", 350],
      ["dispute", -5000],
      ["dispute_fee", -1500],
    ]);
    expect(after.lines[1].items[0].order_id).toBe(disputed.id);
  });

  it("a chargeback won comes back; its fee does not", async () => {
    const a = await organizer("Won");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const o = await sell(e.id, e.ticketTypeId, 1);
    const dispute = { id: `dp_${randomUUID().slice(0, 8)}`, object: "dispute", amount: 2500, currency: "usd", payment_intent: o.stripe_payment_intent_id, reason: "product_not_received" };
    await stripeWebhook("charge.dispute.created", { ...dispute, status: "needs_response" });
    expect((await balances(a)).held).toBe(0); // $23.25 held, minus $25 + $1.75 + $15: the rest from available
    expect((await stripeWebhook("charge.dispute.closed", { ...dispute, status: "won" })).outcome).toBe("dispute_won");
    expect((await stripeWebhook("charge.dispute.closed", { ...dispute, status: "won" })).outcome).toBe("dispute_no_change");
    const b = await balances(a);
    expect(b.held + b.available).toBe(2500 - 175 - 1500);
  });
});

// ---- the standout demo ---------------------------------------------------------

describe("cancel the event while the bank connector is down", () => {
  it("customers are refunded in full, the advance becomes the organizer's obligation, the payout goes out exactly once on recovery, and a recorded decision clears it", async () => {
    const a = await organizer("Night Market");
    const e = await event({ organizers: [[a.id, 10_000]], advance_bps: 5000 });
    const o1 = await sell(e.id, e.ticketTypeId, 2, "Ana"); // $50.00
    const o2 = await sell(e.id, e.ticketTypeId, 1, "Ben"); // $25.00
    expect((await balances(a)).held).toBe(7500 - 525);

    // The bank goes down. The organizer takes an early payout of 50% of what is held.
    bank.behaviour.outage = true;
    const adv = await app.inject({ method: "POST", url: `/organizer/events/${e.id}/advance`, headers: asOrganizer(a.id) });
    expect(adv.statusCode).toBe(200);
    expect(adv.json().advance_cents).toBe(3487);
    const payoutId = adv.json().payout.id;
    await worker.drain(); // the submit fails: 503
    expect((await pool.query("SELECT status FROM payouts WHERE id = $1", [payoutId])).rows[0].status).toBe("pending");
    expect(bank.payouts()).toHaveLength(0);

    // The event is cancelled. Both customers get everything back at once; Stripe is up.
    const cancel = await app.inject({
      method: "POST",
      url: `/organizer/events/${e.id}/cancel`,
      headers: asOrganizer(a.id),
      payload: { reason: "Venue flooded" },
    });
    expect(cancel.json()).toMatchObject({ refunds: 2, replayed: false });
    await drain();
    const { rows: refundRows } = await pool.query("SELECT order_id, amount_cents, status FROM refunds WHERE order_id = ANY($1::uuid[]) ORDER BY amount_cents", [[o1.id, o2.id]]);
    expect(refundRows).toEqual([
      { order_id: o2.id, amount_cents: 2500, status: "succeeded" },
      { order_id: o1.id, amount_cents: 5000, status: "succeeded" },
    ]);
    // Held money covered what it could; the advanced part is now owed.
    expect(await balances(a)).toEqual({ held: 0, available: -3487 });
    const overview = (await organizerOverview(pool, a.id))!;
    expect(overview.balances).toMatchObject({ owed_by_organizer_cents: 3487, in_flight_cents: 3487 });

    // Cancelling again changes nothing.
    const again = await app.inject({ method: "POST", url: `/organizer/events/${e.id}/cancel`, headers: asOrganizer(a.id), payload: { reason: "Venue flooded" } });
    expect(again.json()).toMatchObject({ refunds: 0, replayed: true });

    // The bank comes back. The worker's retry sends the same idempotency key: one payout.
    bank.behaviour.outage = false;
    await sleep(30);
    await drain();
    await settleBank();
    expect((await pool.query("SELECT status FROM payouts WHERE id = $1", [payoutId])).rows[0].status).toBe("succeeded");
    expect(bank.payouts()).toHaveLength(1);

    // The bank's records and ours agree to the cent.
    const run = await runReconciliation(pool, "mock_bank", "USD", { bank });
    expect(run.status).toBe("completed");
    expect(run.totals?.held?.balanced && run.totals?.settled?.balanced).toBe(true);

    // The organizer repays by bank transfer: a person records it, with a cause and a decision.
    const adj = await app.inject({
      method: "POST",
      url: `/admin/organizers/${a.id}/adjustments`,
      headers: { ...AUTH, "idempotency-key": randomUUID() },
      payload: { amount_cents: 3487, cause: "organizer_repaid", note: "Repaid by bank transfer, ref NM-0042", decided_by: "ops@example.test", event_id: e.id },
    });
    expect(adj.statusCode).toBe(201);
    expect(await balances(a)).toEqual({ held: 0, available: 0 });
    const upcoming = (await organizerOverview(pool, a.id))!.upcoming;
    const lines = upcoming.sections.flatMap((s) => s.lines.map((l) => [s.title, l.kind, l.amount_cents]));
    expect(lines).toEqual(
      expect.arrayContaining([
        [expect.stringContaining("after it was paid out"), "refund", -3487],
        ["Your account", "adjustment", 3487],
      ]),
    );
    expect(upcoming.sections.find((s) => s.title === "Your account")!.lines[0].items[0].memo).toContain("Repaid by bank transfer");
  });

  it("if the bank fails the advance instead, the money comes back and the obligation clears itself", async () => {
    const a = await organizer("Fails", FAILS_LATER);
    const e = await event({ organizers: [[a.id, 10_000]], advance_bps: 5000 });
    await sell(e.id, e.ticketTypeId, 2);
    await app.inject({ method: "POST", url: `/organizer/events/${e.id}/advance`, headers: asOrganizer(a.id) });
    await drain();
    await app.inject({ method: "POST", url: `/organizer/events/${e.id}/cancel`, headers: asOrganizer(a.id), payload: { reason: "Rained out" } });
    await drain();
    expect((await balances(a)).available).toBe(-2325);
    await settleBank(); // ...0002: the bank fails it (account_closed)
    expect(await balances(a)).toEqual({ held: 0, available: 0 });
    const kinds = (await organizerOverview(pool, a.id))!.upcoming.sections.flatMap((s) => s.lines.map((l) => l.kind));
    expect(kinds).toContain("payout_failed");
  });

  it("a payment that lands after the event was cancelled is recorded, and refunded straight away", async () => {
    const a = await organizer("Late");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const o = await order((await buyRequest(e.id, e.ticketTypeId, 1)).json().order.id);
    await app.inject({ method: "POST", url: `/organizer/events/${e.id}/cancel`, headers: asOrganizer(a.id), payload: { reason: "Cancelled" } });
    expect((await stripeWebhook("checkout.session.completed", paidSession(o))).outcome).toBe("order_paid");
    const { rows } = await pool.query("SELECT amount_cents, reason FROM refunds WHERE order_id = $1", [o.id]);
    expect(rows).toEqual([{ amount_cents: 2500, reason: "event_cancelled" }]);
    expect(await balances(a)).toEqual({ held: 0, available: 0 });
  });
});

// ---- safety ------------------------------------------------------------------------

describe("who can see what, and what the database refuses", () => {
  it("an organizer cannot see or act on another organizer's events and orders", async () => {
    const a = await organizer("Mine");
    const b = await organizer("Theirs");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const o = await sell(e.id, e.ticketTypeId, 1);
    for (const [method, url] of [
      ["GET", `/organizer/events/${e.id}`],
      ["GET", `/organizer/orders/${o.id}`],
      ["POST", `/organizer/events/${e.id}/advance`],
    ] as const) {
      expect((await app.inject({ method, url, headers: asOrganizer(b.id) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/organizer/", headers: AUTH })).statusCode).toBe(401);
    // An organizer token is not a wallet session.
    expect((await app.inject({ method: "GET", url: "/me/", headers: asOrganizer(a.id) })).statusCode).toBe(401);
  });

  it("the database refuses money on an organizer's account that nothing explains", async () => {
    const a = await organizer("Unexplained");
    await expect(
      withTransaction(pool, async (c) => {
        const { rows } = await c.query<{ id: string }>("SELECT id FROM accounts WHERE system_code = 'platform_fees' AND currency = 'USD'");
        await createTransferInTx(
          c,
          `test:${randomUUID()}`,
          { from_account_id: rows[0].id, to_account_id: a.available_account_id, amount_cents: 100, currency: "USD" },
          { scope: "system" },
        );
      }),
    ).rejects.toThrow(/no organizer_postings row/);
  });

  it("held proceeds can never go negative, even by a bug: the database refuses it", async () => {
    const a = await organizer("Never negative");
    await expect(
      withTransaction(pool, async (c) => {
        await c.query("INSERT INTO transfers (id, idempotency_key, request_hash, from_account_id, to_account_id, amount_cents, currency, status, idempotency_scope) VALUES (gen_random_uuid(), $1, 'x', $2, $3, 1, 'USD', 'posted', 'system')", [
          `test:${randomUUID()}`,
          a.held_account_id,
          a.available_account_id,
        ]);
        await c.query(
          `INSERT INTO ledger_entries (transfer_id, account_id, amount_cents, currency)
           SELECT id, $1, -1, 'USD' FROM transfers WHERE from_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [a.held_account_id],
        );
      }),
    ).rejects.toThrow(/balance_non_negative/);
  });

  it("reconciliation against Stripe matches ticket orders, and settles one whose webhook never came", async () => {
    const a = await organizer("Recon");
    const e = await event({ organizers: [[a.id, 10_000]] });
    const paid = await sell(e.id, e.ticketTypeId, 1);
    stripe.sessions.get(paid.stripe_checkout_session_id)!.payment_status = "paid";
    const lost = await order((await buyRequest(e.id, e.ticketTypeId, 2)).json().order.id);
    // Stripe collected it; the webhook never reached us.
    Object.assign(stripe.sessions.get(lost.stripe_checkout_session_id)!, { payment_status: "paid", status: "complete", payment_intent: "pi_lost" });

    const run = await runReconciliation(pool, "stripe", "USD", { stripe });
    expect(run.status).toBe("completed");
    expect(run.totals?.settled?.balanced).toBe(true);
    // (Orders from earlier tests are unknown to this test's fake Stripe; look at this test's two.)
    const { rows } = await pool.query("SELECT break_key, outcome, object_type FROM reconciliation_items WHERE run_id = $1 AND break_key = ANY($2::text[])", [
      run.id,
      [`order:${paid.id}`, `order:${lost.id}`],
    ]);
    expect(rows).toEqual([{ break_key: `order:${lost.id}`, outcome: "auto_resolved", object_type: "order" }]);
    expect((await order(lost.id)).status).toBe("paid");
  });
});
