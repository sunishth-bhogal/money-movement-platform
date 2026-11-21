import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { checkLedgerInvariants, createAccount } from "../src/ledger/accounts.js";
import type { CheckoutGateway } from "../src/payments/stripe.js";
import { balanceOf, pool } from "./helpers.js";

// A made-up signing secret. Signatures are computed with Stripe's own SDK, so
// the verification path under test is the real one; no Stripe keys needed.
const WEBHOOK_SECRET = "whsec_test_" + randomUUID().replaceAll("-", "");

/** Stands in for Stripe's Checkout API and records how it was called. */
class FakeGateway implements CheckoutGateway {
  calls: { depositId: string; idempotencyKey: string }[] = [];
  failNext = 0;
  async createCheckoutSession(input: { depositId: string }, idempotencyKey: string) {
    this.calls.push({ depositId: input.depositId, idempotencyKey });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated network error");
    }
    // Like Stripe: the same idempotency key returns the same session.
    const id = `cs_test_${idempotencyKey.split(":")[1].replaceAll("-", "")}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }
}

let gateway: FakeGateway;
const app = buildApp(pool, {
  payments: {
    gateway: { createCheckoutSession: (i, k) => gateway.createCheckoutSession(i, k) },
    webhookSecret: WEBHOOK_SECRET,
    appBaseUrl: "http://localhost:3000",
  },
});

beforeEach(() => {
  gateway = new FakeGateway();
});

afterAll(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
  await app.close();
  await pool.end();
});

interface DepositJson {
  id: string;
  account_id: string;
  amount_cents: number;
  status: string;
  stripe_checkout_session_id: string | null;
  checkout_url: string | null;
  transfer_id: string | null;
  failure_reason: string | null;
}

function postDeposit(key: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/deposits", headers: { "idempotency-key": key }, payload: body });
}

async function startDeposit(amount_cents = 2500): Promise<DepositJson> {
  const account = await createAccount(pool, { name: "depositor", currency: "USD" });
  const res = await postDeposit(randomUUID(), { account_id: account.id, amount_cents, currency: "USD" });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function getDeposit(id: string): Promise<DepositJson> {
  return (await app.inject({ method: "GET", url: `/deposits/${id}` })).json();
}

/** A Stripe-shaped checkout.session.* event for a deposit. */
function checkoutEvent(type: string, d: DepositJson, session: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: `evt_test_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: {
      object: {
        id: d.stripe_checkout_session_id,
        object: "checkout.session",
        client_reference_id: d.id,
        metadata: { deposit_id: d.id },
        payment_status: "paid",
        status: "complete",
        amount_total: d.amount_cents,
        currency: "usd",
        payment_intent: "pi_test_123",
        ...session,
      },
    },
    ...extra,
  };
}

function deliver(event: object, opts: { secret?: string; timestamp?: number; body?: string; signature?: string | null } = {}) {
  const payload = JSON.stringify(event);
  const signature =
    opts.signature === undefined
      ? Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: opts.secret ?? WEBHOOK_SECRET,
          timestamp: opts.timestamp,
        })
      : opts.signature;
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", ...(signature === null ? {} : { "stripe-signature": signature }) },
    payload: opts.body ?? payload,
  });
}

async function ledgerPostingsFor(depositId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries e JOIN transfers t ON t.id = e.transfer_id
      WHERE t.idempotency_key = $1`,
    [`deposit:${depositId}`],
  );
  return rows[0].n;
}

async function eventRecorded(eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM processed_events WHERE provider = 'stripe' AND event_id = $1", [
    eventId,
  ]);
  return rowCount === 1;
}

describe("POST /deposits", () => {
  it("opens a Checkout session but moves no money", async () => {
    const d = await startDeposit(2500);
    expect(d.status).toBe("pending");
    expect(d.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(d.stripe_checkout_session_id).toMatch(/^cs_test_/);
    expect(d.transfer_id).toBeNull();
    expect(await balanceOf(d.account_id)).toBe(0);
    expect(gateway.calls).toEqual([{ depositId: d.id, idempotencyKey: `deposit-checkout:${d.id}` }]);
  });

  it("a retried request returns the same deposit and session", async () => {
    const account = await createAccount(pool, { name: "retry", currency: "USD" });
    const key = randomUUID();
    const body = { account_id: account.id, amount_cents: 1000, currency: "USD" };
    const first = await postDeposit(key, body);
    const second = await postDeposit(key, body);
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().checkout_url).toBe(first.json().checkout_url);
    expect(gateway.calls).toHaveLength(1);
  });

  it("if Stripe fails, the deposit stays 'created' and a retry reuses the same Stripe idempotency key", async () => {
    const account = await createAccount(pool, { name: "flaky", currency: "USD" });
    const key = randomUUID();
    const body = { account_id: account.id, amount_cents: 1000, currency: "USD" };
    gateway.failNext = 1;

    const failed = await postDeposit(key, body);
    expect(failed.statusCode).toBe(502);
    const { rows } = await pool.query("SELECT id, status FROM deposits WHERE idempotency_key = $1", [key]);
    expect(rows[0].status).toBe("created");

    const retried = await postDeposit(key, body);
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ id: rows[0].id, status: "pending" });
    expect(gateway.calls.map((c) => c.idempotencyKey)).toEqual([
      `deposit-checkout:${rows[0].id}`,
      `deposit-checkout:${rows[0].id}`,
    ]);
  });

  it("rejects a reused key with a different body, floats, and unknown accounts", async () => {
    const account = await createAccount(pool, { name: "validation", currency: "USD" });
    const key = randomUUID();
    await postDeposit(key, { account_id: account.id, amount_cents: 1000, currency: "USD" });
    expect((await postDeposit(key, { account_id: account.id, amount_cents: 2000, currency: "USD" })).json().error.code).toBe(
      "idempotency_key_reused",
    );
    expect((await postDeposit(randomUUID(), { account_id: account.id, amount_cents: 10.5, currency: "USD" })).statusCode).toBe(400);
    expect((await postDeposit(randomUUID(), { account_id: randomUUID(), amount_cents: 100, currency: "USD" })).statusCode).toBe(404);
  });

  it("returns 503 when Stripe is not configured", async () => {
    const bare = buildApp(pool, { payments: { appBaseUrl: "http://localhost:3000" } });
    const res = await bare.inject({
      method: "POST",
      url: "/deposits",
      headers: { "idempotency-key": randomUUID() },
      payload: { account_id: randomUUID(), amount_cents: 100, currency: "USD" },
    });
    expect(res.statusCode).toBe(503);
    const hook = await bare.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(hook.statusCode).toBe(503);
    await bare.close();
  });
});

describe("the webhook, not the success page, credits the deposit", () => {
  it("landing on the success page changes nothing", async () => {
    const d = await startDeposit();
    const page = await app.inject({ method: "GET", url: `/deposits/${d.id}?checkout=success` });
    expect(page.statusCode).toBe(200);
    expect(page.json().status).toBe("pending");
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("a user who pays and closes the browser is still credited, by the webhook", async () => {
    const d = await startDeposit(2500);
    // No request to the success URL ever happens.
    const res = await deliver(checkoutEvent("checkout.session.completed", d));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, outcome: "deposit_succeeded", deposit_id: d.id });

    const after = await getDeposit(d.id);
    expect(after.status).toBe("succeeded");
    expect(after.transfer_id).not.toBeNull();
    expect(await balanceOf(d.account_id)).toBe(2500);
    expect(await ledgerPostingsFor(d.id)).toBe(2);
    expect(await checkLedgerInvariants(pool)).toEqual([]);
  });
});

describe("duplicate webhooks post to the ledger exactly once", () => {
  it("the same event delivered twice", async () => {
    const d = await startDeposit(4000);
    const event = checkoutEvent("checkout.session.completed", d);

    const first = await deliver(event);
    const second = await deliver(event);
    expect(first.json().outcome).toBe("deposit_succeeded");
    expect(second.statusCode).toBe(200); // acknowledge, so Stripe stops retrying
    expect(second.json().outcome).toBe("duplicate");

    expect(await balanceOf(d.account_id)).toBe(4000);
    expect(await ledgerPostingsFor(d.id)).toBe(2); // one transfer: one debit + one credit
  });

  it("the same event delivered 10 times concurrently", async () => {
    const d = await startDeposit(1500);
    const event = checkoutEvent("checkout.session.completed", d);

    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(event)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const outcomes = results.map((r) => r.json().outcome).sort();
    expect(outcomes.filter((o) => o === "deposit_succeeded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(9);

    expect(await balanceOf(d.account_id)).toBe(1500);
    expect(await ledgerPostingsFor(d.id)).toBe(2);
  });

  it("two different events for the same payment (completed, then async_payment_succeeded)", async () => {
    const d = await startDeposit(3000);
    const [a, b] = await Promise.all([
      deliver(checkoutEvent("checkout.session.completed", d)),
      deliver(checkoutEvent("checkout.session.async_payment_succeeded", d)),
    ]);
    expect([a.json().outcome, b.json().outcome].sort()).toEqual(["already_final", "deposit_succeeded"]);
    expect(await balanceOf(d.account_id)).toBe(3000);
    expect(await ledgerPostingsFor(d.id)).toBe(2);
  });
});

describe("webhook signature verification", () => {
  it("rejects a bad signature and records nothing", async () => {
    const d = await startDeposit(2000);
    const event = checkoutEvent("checkout.session.completed", d);

    const wrongSecret = await deliver(event, { secret: "whsec_not_the_real_one" });
    expect(wrongSecret.statusCode).toBe(400);
    expect(wrongSecret.json().error.code).toBe("invalid_signature");

    expect(await eventRecorded(event.id)).toBe(false);
    expect((await getDeposit(d.id)).status).toBe("pending");
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("rejects a body that was changed after signing", async () => {
    const d = await startDeposit(2000);
    const event = checkoutEvent("checkout.session.completed", d);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: WEBHOOK_SECRET });
    const tampered = JSON.stringify(checkoutEvent("checkout.session.completed", d, { amount_total: 999_999 }, { id: event.id }));

    const res = await deliver(event, { signature, body: tampered });
    expect(res.statusCode).toBe(400);
    expect(await eventRecorded(event.id)).toBe(false);
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("rejects a missing signature, a garbage one, and a replayed old one", async () => {
    const d = await startDeposit(2000);
    const event = checkoutEvent("checkout.session.completed", d);
    expect((await deliver(event, { signature: null })).statusCode).toBe(400);
    expect((await deliver(event, { signature: "t=1,v1=deadbeef" })).statusCode).toBe(400);
    // Correctly signed, but 10 minutes old: outside Stripe's 5-minute tolerance.
    const stale = await deliver(event, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.statusCode).toBe(400);
    expect(await eventRecorded(event.id)).toBe(false);
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("rejects live-mode events", async () => {
    const d = await startDeposit(2000);
    const res = await deliver(checkoutEvent("checkout.session.completed", d, {}, { livemode: true }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("livemode_not_allowed");
    expect(await balanceOf(d.account_id)).toBe(0);
  });
});

describe("payment state", () => {
  it("an async payment goes processing, then failed, and credits nothing", async () => {
    const d = await startDeposit(2000);
    const completed = await deliver(checkoutEvent("checkout.session.completed", d, { payment_status: "unpaid" }));
    expect(completed.json().outcome).toBe("deposit_processing");
    const failed = await deliver(checkoutEvent("checkout.session.async_payment_failed", d, { payment_status: "unpaid" }));
    expect(failed.json().outcome).toBe("deposit_failed");

    // A late success for a failed deposit is not applied.
    const late = await deliver(checkoutEvent("checkout.session.async_payment_succeeded", d));
    expect(late.json().outcome).toBe("already_final");
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("an async payment goes processing, then succeeded", async () => {
    const d = await startDeposit(2000);
    await deliver(checkoutEvent("checkout.session.completed", d, { payment_status: "unpaid" }));
    expect((await getDeposit(d.id)).status).toBe("processing");
    await deliver(checkoutEvent("checkout.session.async_payment_succeeded", d));
    expect((await getDeposit(d.id)).status).toBe("succeeded");
    expect(await balanceOf(d.account_id)).toBe(2000);
  });

  it("an abandoned Checkout expires", async () => {
    const d = await startDeposit(2000);
    const res = await deliver(checkoutEvent("checkout.session.expired", d, { payment_status: "unpaid", status: "expired" }));
    expect(res.json().outcome).toBe("deposit_expired");
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("a paid amount that differs from the deposit is held for review, not credited", async () => {
    const d = await startDeposit(2000);
    const res = await deliver(checkoutEvent("checkout.session.completed", d, { amount_total: 2001 }));
    expect(res.json().outcome).toBe("deposit_requires_review");
    expect((await getDeposit(d.id)).failure_reason).toMatch(/amount_mismatch/);
    expect(await balanceOf(d.account_id)).toBe(0);
  });

  it("ignores events for other sessions or other event types, but acknowledges them", async () => {
    const d = await startDeposit(2000);
    const other = await deliver(checkoutEvent("checkout.session.completed", d, { id: "cs_test_someone_else" }));
    expect(other.json().outcome).toBe("ignored");
    const unrelated = await deliver({ ...checkoutEvent("customer.created", d), data: { object: { id: "cus_1" } } });
    expect(unrelated.statusCode).toBe(200);
    expect(unrelated.json().outcome).toBe("ignored");
    expect(await balanceOf(d.account_id)).toBe(0);
  });
});
