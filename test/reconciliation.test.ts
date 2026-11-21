import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { listAllBankPayouts, type BankClient } from "../src/bank/client.js";
import { MockBank, type BankWebhookEvent } from "../src/bank/mockBank.js";
import { BANK_SIGNATURE_HEADER, signBankWebhook } from "../src/bank/signature.js";
import { checkLedgerInvariants, createAccount } from "../src/ledger/accounts.js";
import { createTransfer } from "../src/ledger/transfers.js";
import { routingPublisher } from "../src/outbox/publishers.js";
import { OutboxWorker, type Publisher } from "../src/outbox/worker.js";
import type { CheckoutGateway, StripeRecordSource, StripeSessionRecord } from "../src/payments/stripe.js";
import { bankIdempotencyKey, checkPayoutInvariants, getPayout, PAYOUT_SUBMIT_EVENT } from "../src/payouts/payouts.js";
import { payoutSubmitter } from "../src/payouts/submitter.js";
import type { ReconRun } from "../src/reconciliation/run.js";
import { balanceOf, pool } from "./helpers.js";

const BANK_SECRET = "test_bank_webhook_secret";
const STRIPE_SECRET = "whsec_test_" + randomUUID().replaceAll("-", "");
const ADMIN_TOKEN = "test-admin-token";
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SUCCEEDS = "000123451111";
const FAILS_LATER = "000123450002";
const REFUSED = "000123450004";
const RETURNED = "000123450005";

/**
 * Stripe, as far as deposits and reconciliation can see it: Checkout Sessions
 * we create, that a customer may pay, and a list endpoint that reports them.
 */
class FakeStripe implements CheckoutGateway, StripeRecordSource {
  sessions = new Map<string, StripeSessionRecord>();
  /** Fail listing on this page number (1-based), to cut the response off mid-way. */
  failOnPage?: number;
  pageSize = 100;

  async createCheckoutSession(input: { depositId: string; amountCents: number; currency: string }, idempotencyKey: string) {
    const id = `cs_test_${idempotencyKey.split(":")[1].replaceAll("-", "")}`;
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        client_reference_id: input.depositId,
        metadata: { deposit_id: input.depositId },
        status: "open",
        payment_status: "unpaid",
        amount_total: input.amountCents,
        currency: input.currency.toLowerCase(),
        payment_intent: null,
        created: Math.floor(Date.now() / 1000),
      });
    }
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }

  /** The customer pays (optionally a different amount). Returns the webhook event Stripe would send. */
  pay(sessionId: string, amount?: number) {
    const s = this.sessions.get(sessionId)!;
    Object.assign(s, {
      status: "complete",
      payment_status: "paid",
      amount_total: amount ?? s.amount_total,
      payment_intent: `pi_test_${randomUUID().slice(0, 8)}`,
    });
    return {
      id: `evt_test_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      api_version: Stripe.API_VERSION,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: "checkout.session.completed",
      data: { object: { object: "checkout.session", ...s } },
    };
  }

  async listCheckoutSessions(page: { starting_after?: string }, _signal?: AbortSignal) {
    const all = [...this.sessions.values()];
    const start = page.starting_after ? all.findIndex((s) => s.id === page.starting_after) + 1 : 0;
    const pageNo = Math.floor(start / this.pageSize) + 1;
    if (this.failOnPage === pageNo) throw new Error("socket hang up");
    return { data: all.slice(start, start + this.pageSize).map((s) => ({ ...s })), has_more: start + this.pageSize < all.length };
  }
}

/** A bank client that cuts off the statement on the Nth page (and pages one payout at a time). */
function cutOffStatement(bank: MockBank, failOnPage: number): BankClient {
  let page = 0;
  return {
    createPayout: (r, s) => bank.createPayout(r, s),
    getPayoutByKey: (k, s) => bank.getPayoutByKey(k, s),
    async listPayouts(p, s) {
      if (++page === failOnPage) throw new Error("connection reset by peer");
      return bank.listPayouts({ ...p, limit: 1 }, s);
    },
  };
}

let clock: number;
let bank: MockBank;
let stripe: FakeStripe;
let bankClient: BankClient;
let worker: OutboxWorker;
let webhooksDown: boolean;

const nothing: Publisher = { publish: async () => {} };

const app = buildApp(pool, {
  bankWebhookSecret: BANK_SECRET,
  payments: {
    gateway: { createCheckoutSession: (i, k) => stripe.createCheckoutSession(i, k) },
    webhookSecret: STRIPE_SECRET,
    appBaseUrl: "http://localhost:3000",
  },
  admin: {
    token: ADMIN_TOKEN,
    providers: {
      bank: {
        createPayout: (r, s) => bankClient.createPayout(r, s),
        getPayoutByKey: (k, s) => bankClient.getPayoutByKey(k, s),
        listPayouts: (p, s) => bankClient.listPayouts(p, s),
      },
      stripe: { listCheckoutSessions: (p, s) => stripe.listCheckoutSessions(p, s) },
    },
  },
});

beforeEach(async () => {
  await pool.query("UPDATE outbox SET status = 'published', published_at = now(), claim_token = NULL WHERE status <> 'published'");
  clock = Date.now();
  webhooksDown = false;
  stripe = new FakeStripe();
  bank = new MockBank({
    now: () => clock,
    behaviour: { settleAfterMs: 1_000 },
    deliver: async (event) => {
      if (webhooksDown) throw new Error("connection refused");
      const res = await deliverBankWebhook(event);
      if (res.statusCode !== 200) throw new Error(`webhook answered ${res.statusCode}`);
    },
  });
  bankClient = bank;
  worker = new OutboxWorker(pool, routingPublisher({ [PAYOUT_SUBMIT_EVENT]: payoutSubmitter(pool, bank) }, nothing), {
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    baseDelayMs: 5,
    maxDelayMs: 20,
    maxAttempts: 3,
  });
});

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
  expect(await checkPayoutInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

// ---- helpers ------------------------------------------------------------------

// Each test works in its own currency, so its runs see only its own money
// (control accounts and statements are per currency).
let nextCurrency = 0;
function freshCurrency(): string {
  const n = nextCurrency++;
  return `R${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}`;
}

async function userWith(currency: string, cents: number, name = "user"): Promise<string> {
  const user = await createAccount(pool, { name, currency });
  if (cents > 0) {
    const funding = await createAccount(pool, { name: `funding ${currency}`, currency, kind: "system" });
    await createTransfer(pool, randomUUID(), { from_account_id: funding.id, to_account_id: user.id, amount_cents: cents, currency }, { scope: "system" });
  }
  return user.id;
}

function deliverBankWebhook(event: BankWebhookEvent) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/bank",
    headers: { "content-type": "application/json", [BANK_SIGNATURE_HEADER]: signBankWebhook(BANK_SECRET, body) },
    payload: body,
  });
}

function deliverStripeWebhook(event: object) {
  const payload = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: {
      "content-type": "application/json",
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET }),
    },
    payload,
  });
}

async function requestPayout(account: string, currency: string, cents: number, accountNumber = SUCCEEDS): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/payouts",
    headers: { ...AUTH, "idempotency-key": randomUUID() },
    payload: { account_id: account, amount_cents: cents, currency, bank_account_number: accountNumber },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function submitStatus(payoutId: string) {
  const { rows } = await pool.query<{ status: string }>(
    "SELECT status FROM outbox WHERE aggregate_id = $1 AND event_type = $2 ORDER BY id DESC LIMIT 1",
    [payoutId, PAYOUT_SUBMIT_EVENT],
  );
  return rows[0].status;
}

/** Run the worker until the payout's submit event is published or dead. */
async function driveSubmit(payoutId: string) {
  for (let i = 0; i < 200; i++) {
    await worker.drain();
    const s = await submitStatus(payoutId);
    if (s !== "pending") return s;
    await sleep(5);
  }
  throw new Error("submit never settled");
}

/** A payout that went all the way through the bank, normally. */
async function settledPayout(account: string, currency: string, cents: number, accountNumber = SUCCEEDS) {
  const id = await requestPayout(account, currency, cents, accountNumber);
  await driveSubmit(id);
  await advance(1_000);
  await advance(1_000); // a ...0005 payout is returned a second after it succeeds
  return id;
}

async function advance(ms: number) {
  clock += ms;
  await bank.processDue();
}

async function deposit(account: string, currency: string, cents: number) {
  const res = await app.inject({
    method: "POST",
    url: "/deposits",
    headers: { ...AUTH, "idempotency-key": randomUUID() },
    payload: { account_id: account, amount_cents: cents, currency },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; stripe_checkout_session_id: string };
}

async function runRecon(source: "mock_bank" | "stripe", currency: string) {
  return app.inject({ method: "POST", url: "/admin/reconciliation/runs", headers: AUTH, payload: { source, currency } });
}

/** Run, expect it to complete, and return the run with its items. */
async function reconcile(source: "mock_bank" | "stripe", currency: string) {
  const res = await runRecon(source, currency);
  expect(res.statusCode, res.body).toBe(201);
  const run = res.json() as ReconRun;
  const detail = await app.inject({ method: "GET", url: `/admin/reconciliation/runs/${run.id}`, headers: AUTH });
  return detail.json() as { run: ReconRun; items: ItemJson[] };
}

interface ItemJson {
  id: string;
  break_key: string;
  classification: string;
  outcome: string;
  auto_action: string | null;
  auto_transfer_ids: string[];
  our_status: string | null;
  provider_status: string | null;
  ledger_held_cents: number;
  ledger_settled_cents: number;
  provider_held_cents: number;
  provider_settled_cents: number;
  detail: string;
}

function resolve(itemId: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/admin/reconciliation/items/${itemId}/resolve`,
    headers: AUTH,
    payload: { note: "checked with the provider", resolved_by: "ops@example.test", ...body },
  });
}

/** The proof: ledger totals equal provider totals plus what the remaining items explain, with nothing unexplained. */
function expectBalanced(run: ReconRun) {
  for (const proof of Object.values(run.totals ?? {})) {
    expect(proof!.unattributed_cents).toBe(0);
    expect(proof!.ledger_cents - proof!.provider_cents).toBe(proof!.explained_cents);
    expect(proof!.balanced).toBe(true);
  }
}

async function systemBalance(code: string, currency: string): Promise<number> {
  const { rows } = await pool.query<{ balance_cents: number }>(
    "SELECT balance_cents FROM accounts WHERE system_code = $1 AND currency = $2",
    [code, currency],
  );
  return rows[0]?.balance_cents ?? 0;
}

async function postingKeys(payoutId: string) {
  const { rows } = await pool.query<{ key: string }>(
    "SELECT idempotency_key AS key FROM transfers WHERE idempotency_key LIKE $1 AND status = 'posted' ORDER BY created_at",
    [`payout:${payoutId}:%`],
  );
  return rows.map((r) => r.key.split(":")[2]);
}

// ---- tests --------------------------------------------------------------------

describe("a clean period: every dollar on both sides is accounted for", () => {
  it("payouts across every outcome and paid deposits all match, and the totals tie out to the cent", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 100_00, "alice");
    await settledPayout(alice, cur, 10_00, SUCCEEDS);
    await settledPayout(alice, cur, 11_00, FAILS_LATER);
    await settledPayout(alice, cur, 12_00, REFUSED);
    await settledPayout(alice, cur, 13_00, RETURNED);
    const inFlight = await requestPayout(alice, cur, 14_00);
    await driveSubmit(inFlight); // the bank has it, still processing

    const bob = await userWith(cur, 0, "bob");
    const d = await deposit(bob, cur, 25_00);
    expect((await deliverStripeWebhook(stripe.pay(d.stripe_checkout_session_id))).statusCode).toBe(200);
    await deposit(bob, cur, 7_00); // opened, never paid

    const bankRun = await reconcile("mock_bank", cur);
    expect(bankRun.run).toMatchObject({ status: "completed", provider_records: 5, ledger_records: 5, matched: 5, open_breaks: 0 });
    expect(bankRun.items).toEqual([]);
    expectBalanced(bankRun.run);
    // Bank payouts holds the one that succeeded; in flight holds the one the bank is processing.
    expect(bankRun.run.totals!.settled).toMatchObject({ ledger_cents: 10_00, provider_cents: 10_00 });
    expect(bankRun.run.totals!.held).toMatchObject({ ledger_cents: 14_00, provider_cents: 14_00 });

    const stripeRun = await reconcile("stripe", cur);
    expect(stripeRun.run).toMatchObject({ status: "completed", provider_records: 2, matched: 2, open_breaks: 0 });
    expect(stripeRun.run.totals!.settled).toMatchObject({ ledger_cents: 25_00, provider_cents: 25_00, balanced: true });
  });
});

describe("How do we prove where every dollar went? Uncertain states, resolved from the provider's own records", () => {
  it("the bank's response is cut off, retries run out, no webhook ever comes: the statement settles it, exactly once", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.webhooksEnabled = false;
    bank.behaviour.loseResponses = 1;
    const p = await requestPayout(alice, cur, 20_00);

    await worker.runOnce(); // the bank creates the payout; its response never reaches us
    bank.behaviour.outage = true;
    expect(await driveSubmit(p)).toBe("dead");
    bank.behaviour.outage = false;
    expect(await getPayout(pool, p)).toMatchObject({ status: "pending", provider_payout_id: null });

    // While the bank is still processing, "we hold it, they are paying it" is
    // the same money in the same place. Uncertain to us, but not a break.
    const early = await reconcile("mock_bank", cur);
    expect(early.run).toMatchObject({ matched: 1, open_breaks: 0 });

    await advance(1_000); // the bank pays it out. Nobody tells us.
    const run = await reconcile("mock_bank", cur);
    expect(run.run).toMatchObject({ auto_resolved: 1, open_breaks: 0 });
    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({
      break_key: `payout:${p}`,
      classification: "status_mismatch",
      outcome: "auto_resolved",
      our_status: "pending",
      provider_status: "succeeded",
      ledger_held_cents: 20_00, // what the run found...
      provider_settled_cents: 20_00,
    });
    expect(run.items[0].auto_transfer_ids).toHaveLength(1); // ...and the one settle transfer that fixed it
    expectBalanced(run.run);

    expect(await getPayout(pool, p)).toMatchObject({ status: "succeeded", provider_payout_id: bank.payouts()[0].id });
    expect(await postingKeys(p)).toEqual(["hold", "settle"]);
    expect(await balanceOf(alice)).toBe(30_00);
    expect(bank.payouts()).toHaveLength(1); // never sent twice

    // Running it again finds nothing to do and posts nothing.
    const again = await reconcile("mock_bank", cur);
    expect(again.run).toMatchObject({ matched: 1, auto_resolved: 0, open_breaks: 0 });
    expect(await postingKeys(p)).toEqual(["hold", "settle"]);

    // And the trace shows where the money went, transfer by transfer.
    const trace = (await app.inject({ method: "GET", url: `/admin/reconciliation/trace?break_key=payout:${p}`, headers: AUTH })).json();
    expect(trace.transfers.map((t: { idempotency_key: string }) => t.idempotency_key.split(":")[2])).toEqual(["hold", "settle"]);
    expect(trace.transfers[1].entries.map((e: { account: string; amount_cents: number }) => [e.account, e.amount_cents])).toEqual([
      [`Payouts in flight (${cur})`, -20_00],
      [`Bank payouts (${cur})`, 20_00],
    ]);
  });

  it("same, but the bank failed it: the statement reverses the hold and the user is whole", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.webhooksEnabled = false;
    const p = await requestPayout(alice, cur, 20_00, FAILS_LATER);
    await driveSubmit(p);
    await advance(1_000);
    expect((await getPayout(pool, p))!.status).toBe("submitted");

    const run = await reconcile("mock_bank", cur);
    expect(run.items[0]).toMatchObject({ outcome: "auto_resolved", provider_status: "failed" });
    expect(await postingKeys(p)).toEqual(["hold", "reverse"]);
    expect(await balanceOf(alice)).toBe(50_00);
  });

  it("Stripe charged the card but the webhook was lost: the run credits the deposit once, and the late webhook changes nothing", async () => {
    const cur = freshCurrency();
    const bob = await userWith(cur, 0);
    const d = await deposit(bob, cur, 25_00);
    const event = stripe.pay(d.stripe_checkout_session_id); // paid at Stripe; the webhook never arrives
    expect(await balanceOf(bob)).toBe(0);

    const run = await reconcile("stripe", cur);
    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({
      break_key: `deposit:${d.id}`,
      classification: "status_mismatch",
      outcome: "auto_resolved",
      ledger_settled_cents: 0,
      provider_settled_cents: 25_00,
    });
    expectBalanced(run.run);
    expect(await balanceOf(bob)).toBe(25_00);

    // The webhook turns up after all (Stripe retries for days).
    const late = await deliverStripeWebhook(event);
    expect(late.json().outcome).toBe("already_final");
    expect(await balanceOf(bob)).toBe(25_00);
    expect((await reconcile("stripe", cur)).run).toMatchObject({ matched: 1, open_breaks: 0 });
  });

  it("the provider's statement is itself cut off mid-way: the run fails, changes nothing, and the next one completes", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.webhooksEnabled = false;
    const ps = [await requestPayout(alice, cur, 5_00), await requestPayout(alice, cur, 6_00), await requestPayout(alice, cur, 7_00)];
    for (const p of ps) await driveSubmit(p);
    await advance(1_000); // all three paid out; we still think "submitted"

    bankClient = cutOffStatement(bank, 2); // page 1 arrives, then the connection drops
    const failed = await runRecon("mock_bank", cur);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().run).toMatchObject({ status: "failed", open_breaks: null });
    expect(failed.json().run.error).toMatch(/connection reset/);
    // Not one payout was judged on a partial statement.
    for (const p of ps) expect((await getPayout(pool, p))!.status).toBe("submitted");
    const { rowCount } = await pool.query("SELECT 1 FROM reconciliation_items WHERE run_id = $1", [failed.json().run.id]);
    expect(rowCount).toBe(0);

    bankClient = bank;
    const run = await reconcile("mock_bank", cur);
    expect(run.run).toMatchObject({ provider_records: 3, auto_resolved: 3, open_breaks: 0 });
    for (const p of ps) expect((await getPayout(pool, p))!.status).toBe("succeeded");
    expectBalanced(run.run);
  });

  it("the same for Stripe: a cut-off session list fails the run instead of calling paid deposits missing", async () => {
    const cur = freshCurrency();
    const bob = await userWith(cur, 0);
    for (const cents of [1_00, 2_00, 3_00]) {
      const d = await deposit(bob, cur, cents);
      await deliverStripeWebhook(stripe.pay(d.stripe_checkout_session_id));
    }
    stripe.pageSize = 1;
    stripe.failOnPage = 3;
    expect((await runRecon("stripe", cur)).statusCode).toBe(502);
    stripe.failOnPage = undefined;
    expect((await reconcile("stripe", cur)).run).toMatchObject({ matched: 3, open_breaks: 0 });
  });

  it("a pending payout the bank never received is in transit, not failed; once nothing will resend it, the run re-queues it", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.outage = true;
    const p = await requestPayout(alice, cur, 20_00);
    expect(await driveSubmit(p)).toBe("dead");
    bank.behaviour.outage = false;

    const run = await reconcile("mock_bank", cur);
    expect(run.items[0]).toMatchObject({ classification: "missing_at_provider", outcome: "in_transit", auto_action: "resubmitted" });
    expect(run.run.open_breaks).toBe(0);
    expect(await balanceOf(alice)).toBe(30_00); // still held: never refunded on a guess

    await driveSubmit(p);
    await advance(1_000);
    expect((await getPayout(pool, p))!.status).toBe("succeeded");
    expect(bank.payouts()).toHaveLength(1);
    expect((await reconcile("mock_bank", cur)).run).toMatchObject({ matched: 1, in_transit: 0 });
  });
});

describe("breaks only a person can decide, and resolutions recorded as ledger postings", () => {
  it("the bank says failed after we settled it: an open break; accepting the bank refunds the user with a linked posting", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    const p = await settledPayout(alice, cur, 20_00);
    expect(await balanceOf(alice)).toBe(30_00);

    bank.tamper(bankIdempotencyKey(p), { status: "failed", failure_code: "recalled" });
    bank.emit(bank.payouts()[0], "payout.failed"); // the contradiction also arrives as a webhook
    await bank.flushWebhooks();
    expect((await getPayout(pool, p))!.discrepancy).toMatch(/bank reports failed, we recorded succeeded/);

    const run = await reconcile("mock_bank", cur);
    expect(run.run.open_breaks).toBe(1);
    const it = run.items[0];
    expect(it).toMatchObject({ classification: "status_mismatch", outcome: "open", our_status: "succeeded", provider_status: "failed" });
    expect(it).toMatchObject({ ledger_settled_cents: 20_00, provider_settled_cents: 0 });
    expectBalanced(run.run); // the 20.00 the bank and we disagree on is exactly this item

    const res = await resolve(it.id, { action: "accept_provider", counterparty: "user" });
    expect(res.statusCode, res.body).toBe(201);
    const resolution = res.json();
    expect(resolution).toMatchObject({ action: "accept_provider", counterparty: "user", resolved_by: "ops@example.test" });
    expect(resolution.transfer_ids).toHaveLength(1);
    expect(await balanceOf(alice)).toBe(50_00);
    expect(await systemBalance("bank_payouts", cur)).toBe(0);
    // The original postings are untouched; the correction is a new transfer next to them.
    expect(await postingKeys(p)).toEqual(["hold", "settle"]);
    const { rows } = await pool.query("SELECT idempotency_key FROM transfers WHERE id = $1", [resolution.transfer_ids[0]]);
    expect(rows[0].idempotency_key).toBe(`recon:${resolution.id}:1`);

    // The money agrees now. The payout's flag is still there until someone acknowledges it.
    expect((await reconcile("mock_bank", cur)).run).toMatchObject({ matched: 1, open_breaks: 0 });
    const flagged = (await app.inject({ method: "GET", url: "/admin/payouts/flagged", headers: AUTH })).json().flagged;
    expect(flagged.find((f: { id: string }) => f.id === p).acknowledged).toBeNull();
    const ack = await app.inject({
      method: "POST",
      url: `/admin/payouts/${p}/acknowledge`,
      headers: AUTH,
      payload: { note: "bank recalled it; refunded via reconciliation", resolved_by: "ops@example.test" },
    });
    expect(ack.statusCode).toBe(201);
    const after = (await app.inject({ method: "GET", url: "/admin/payouts/flagged", headers: AUTH })).json().flagged;
    expect(after.find((f: { id: string }) => f.id === p).acknowledged).toMatchObject({ resolved_by: "ops@example.test" });
  });

  it("we refunded a payout the bank actually paid: the user is debited if they can cover it, otherwise the platform absorbs it", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    const p = await settledPayout(alice, cur, 20_00, FAILS_LATER); // failed and reversed: alice is back to 50
    bank.tamper(bankIdempotencyKey(p), { status: "succeeded", failure_code: null });

    // Alice spends most of it before anyone notices.
    const bob = await userWith(cur, 0);
    await createTransfer(pool, randomUUID(), { from_account_id: alice, to_account_id: bob, amount_cents: 45_00, currency: cur });

    const run = await reconcile("mock_bank", cur);
    const it = run.items[0];
    expect(it).toMatchObject({ outcome: "open", our_status: "failed", provider_status: "succeeded", provider_settled_cents: 20_00 });

    const fromUser = await resolve(it.id, { action: "accept_provider", counterparty: "user" });
    expect(fromUser.statusCode).toBe(422);
    expect(fromUser.json().error.code).toBe("insufficient_funds");
    // A refused correction leaves no trace: no resolution, no transfer.
    expect((await pool.query("SELECT 1 FROM reconciliation_resolutions WHERE item_id = $1", [it.id])).rowCount).toBe(0);

    const fromPlatform = await resolve(it.id, { action: "accept_provider", counterparty: "platform", note: "user spent it; written off" });
    expect(fromPlatform.statusCode).toBe(201);
    expect(await balanceOf(alice)).toBe(5_00);
    expect(await systemBalance("reconciliation_adjustments", cur)).toBe(-20_00); // the loss, on the books
    expect(await systemBalance("bank_payouts", cur)).toBe(20_00); // matches the bank
    expect((await reconcile("mock_bank", cur)).run).toMatchObject({ open_breaks: 0 });
  });

  it("the bank lost a payout it acknowledged: still held; a person who confirms it was never paid returns the money", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.webhooksEnabled = false;
    const p = await requestPayout(alice, cur, 20_00);
    await driveSubmit(p);
    bank.forget(bankIdempotencyKey(p));

    const run = await reconcile("mock_bank", cur);
    const it = run.items[0];
    expect(it).toMatchObject({ classification: "missing_at_provider", outcome: "open", our_status: "submitted", ledger_held_cents: 20_00 });
    expect(await balanceOf(alice)).toBe(30_00);

    expect((await resolve(it.id, { action: "accept_provider", counterparty: "user" })).statusCode).toBe(201);
    expect(await balanceOf(alice)).toBe(50_00);
    expect(await systemBalance("payouts_in_flight", cur)).toBe(0);
    expect((await reconcile("mock_bank", cur)).run).toMatchObject({ open_breaks: 0 });
  });

  it("a payout at the bank we never sent: only the platform can absorb it", async () => {
    const cur = freshCurrency();
    const stranger = bank.inject({
      idempotency_key: "not-ours-1",
      reference: "someone else",
      amount_cents: 9_99,
      currency: cur,
      account_number: SUCCEEDS,
      status: "succeeded",
      failure_code: null,
    });
    const run = await reconcile("mock_bank", cur);
    const it = run.items[0];
    expect(it).toMatchObject({ break_key: `bank_payout:${stranger.id}`, classification: "missing_in_ledger", outcome: "open" });
    expectBalanced(run.run);

    expect((await resolve(it.id, { action: "accept_provider", counterparty: "user" })).json().error.code).toBe("no_user");
    expect((await resolve(it.id, { action: "accept_provider", counterparty: "platform" })).statusCode).toBe(201);
    expect(await systemBalance("bank_payouts", cur)).toBe(9_99);
    expect(await systemBalance("reconciliation_adjustments", cur)).toBe(-9_99);
    const next = await reconcile("mock_bank", cur);
    expect(next.run).toMatchObject({ matched: 1, open_breaks: 0 });
    expectBalanced(next.run);
  });

  it("accept_ours moves no money; the same disagreement stays settled on later runs, and any change brings it back", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    const p = await settledPayout(alice, cur, 20_00);
    bank.tamper(bankIdempotencyKey(p), { status: "failed" });

    const first = await reconcile("mock_bank", cur);
    expect((await resolve(first.items[0].id, { action: "accept_ours", note: "bank confirmed a display error" })).statusCode).toBe(201);
    expect(await balanceOf(alice)).toBe(30_00);

    const second = await reconcile("mock_bank", cur);
    expect(second.items[0]).toMatchObject({ outcome: "acknowledged" });
    expect(second.run).toMatchObject({ open_breaks: 0, acknowledged: 1 });
    expectBalanced(second.run); // acknowledged, but still counted: the 20.00 difference is still explained by this item

    bank.tamper(bankIdempotencyKey(p), { status: "returned" }); // the bank's story changes
    const third = await reconcile("mock_bank", cur);
    expect(third.items[0]).toMatchObject({ outcome: "open", provider_status: "returned" });
  });

  it("Stripe collected a different amount (held for review): accepting Stripe credits what was actually collected", async () => {
    const cur = freshCurrency();
    const bob = await userWith(cur, 0);
    const d = await deposit(bob, cur, 25_00);
    expect((await deliverStripeWebhook(stripe.pay(d.stripe_checkout_session_id, 24_00))).json().outcome).toBe("deposit_requires_review");

    const run = await reconcile("stripe", cur);
    const it = run.items[0];
    expect(it).toMatchObject({ classification: "amount_mismatch", outcome: "open", ledger_settled_cents: 0, provider_settled_cents: 24_00 });
    expect((await resolve(it.id, { action: "accept_provider", counterparty: "user" })).statusCode).toBe(201);
    expect(await balanceOf(bob)).toBe(24_00);
    expect(await systemBalance("stripe_clearing", cur)).toBe(-24_00);
    expect((await reconcile("stripe", cur)).run).toMatchObject({ matched: 1, open_breaks: 0 });
  });
});

describe("resolving safely", () => {
  async function openBreak() {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    const p = await settledPayout(alice, cur, 20_00);
    bank.tamper(bankIdempotencyKey(p), { status: "failed" });
    const run = await reconcile("mock_bank", cur);
    return { cur, alice, p, item: run.items[0] };
  }

  it("10 simultaneous clicks on 'accept' post one correction; a different decision afterwards is refused", async () => {
    const { alice, item } = await openBreak();
    const results = await Promise.all(Array.from({ length: 10 }, () => resolve(item.id, { action: "accept_provider", counterparty: "user" })));
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(9);
    expect(await balanceOf(alice)).toBe(50_00); // refunded once, not ten times

    expect((await resolve(item.id, { action: "accept_ours" })).statusCode).toBe(409);
  });

  it("a break from an older run is refused once a newer run exists", async () => {
    const { cur, item } = await openBreak();
    await reconcile("mock_bank", cur);
    const res = await resolve(item.id, { action: "accept_provider", counterparty: "user" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("stale_item");
  });

  it("if the money moved since the run looked, the correction is refused rather than applied twice", async () => {
    const cur = freshCurrency();
    const alice = await userWith(cur, 50_00);
    bank.behaviour.webhooksEnabled = false;
    const p = await requestPayout(alice, cur, 20_00);
    await driveSubmit(p);
    bank.forget(bankIdempotencyKey(p));
    const { items } = await reconcile("mock_bank", cur);

    // Meanwhile the bank finds it again and a webhook settles it.
    const found = bank.inject({
      id: (await getPayout(pool, p))!.provider_payout_id!,
      idempotency_key: bankIdempotencyKey(p),
      reference: p,
      amount_cents: 20_00,
      currency: cur,
      account_number: SUCCEEDS,
      status: "succeeded",
      failure_code: null,
    });
    bank.behaviour.webhooksEnabled = true;
    bank.emit(found, "payout.succeeded");
    await bank.flushWebhooks();
    expect((await getPayout(pool, p))!.status).toBe("succeeded");

    const res = await resolve(items[0].id, { action: "accept_provider", counterparty: "user" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ledger_changed");
    expect(await balanceOf(alice)).toBe(30_00); // not refunded on top of the payout going out
  });

  it("two runs for the same source and currency at once: the second is refused", async () => {
    const cur = freshCurrency();
    bank.behaviour.latencyMs = 200;
    const [a, b] = await Promise.all([runRecon("mock_bank", cur), runRecon("mock_bank", cur)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it("runs, items and resolutions are evidence: they cannot be edited or deleted", async () => {
    const { item } = await openBreak();
    await resolve(item.id, { action: "accept_provider", counterparty: "user" });
    for (const sql of [
      "UPDATE reconciliation_items SET outcome = 'open'",
      "DELETE FROM reconciliation_items",
      "UPDATE reconciliation_resolutions SET note = 'changed'",
      "DELETE FROM reconciliation_resolution_postings",
      "UPDATE reconciliation_runs SET open_breaks = 0 WHERE status <> 'running'",
      "DELETE FROM reconciliation_runs",
    ]) {
      await expect(pool.query(sql), sql).rejects.toMatchObject({ code: "23001" });
    }
  });

  it("the admin API needs the token", async () => {
    const none = await app.inject({ method: "GET", url: "/admin/summary" });
    const wrong = await app.inject({ method: "GET", url: "/admin/summary", headers: { authorization: "Bearer nope" } });
    expect([none.statusCode, wrong.statusCode]).toEqual([401, 401]);
    const unconfigured = buildApp(pool);
    expect((await unconfigured.inject({ method: "GET", url: "/admin/summary", headers: AUTH })).statusCode).toBe(503);
    await unconfigured.close();
    const ok = await app.inject({ method: "GET", url: "/admin/summary", headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty("open_breaks");
  });
});

describe("over HTTP: the mock bank's statement endpoint", () => {
  it("lists every payout across pages", async () => {
    const { buildMockBankServer } = await import("../src/bank/mockBankServer.js");
    const { httpBankClient } = await import("../src/bank/client.js");
    const remote = new MockBank();
    for (let i = 0; i < 5; i++) {
      await remote.createPayout({ idempotency_key: `k${i}`, reference: `r${i}`, amount_cents: 100 + i, currency: "USD", account_number: SUCCEEDS });
    }
    const server = buildMockBankServer(remote);
    const url = await server.listen({ port: 0, host: "127.0.0.1" });
    try {
      const all = await listAllBankPayouts(httpBankClient(url), undefined, 2);
      expect(all.map((p) => p.amount_cents)).toEqual([100, 101, 102, 103, 104]);
    } finally {
      await server.close();
    }
  });
});
