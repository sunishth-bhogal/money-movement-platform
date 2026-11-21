import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBank, type BankWebhookEvent } from "../src/bank/mockBank.js";
import { BANK_SIGNATURE_HEADER, signBankWebhook } from "../src/bank/signature.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import type { OutboxEvent } from "../src/outbox/outbox.js";
import { routingPublisher } from "../src/outbox/publishers.js";
import { OutboxWorker, type Publisher } from "../src/outbox/worker.js";
import { bankIdempotencyKey, checkPayoutInvariants, getPayout, PAYOUT_SUBMIT_EVENT, type Payout } from "../src/payouts/payouts.js";
import { reconcilePayouts } from "../src/payouts/reconcile.js";
import { payoutSubmitter } from "../src/payouts/submitter.js";
import { AS_OPERATOR, balanceOf, operatorAuth, pool, userWithBalance } from "./helpers.js";

const SECRET = "test_bank_webhook_secret";
const app = buildApp(pool, { ...operatorAuth, bankWebhookSecret: SECRET });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Account numbers that pick the mock bank's behaviour (see src/bank/mockBank.ts).
const SUCCEEDS = "000123451111";
const FAILS_LATER = "000123450002";
const REFUSED = "000123450004";
const RETURNED = "000123450005";

/** Other downstream consumers: every outbox event that isn't a command to the bank. */
class Downstream implements Publisher {
  events: OutboxEvent[] = [];
  async publish(event: OutboxEvent) {
    this.events.push(event);
  }
  types(aggregateId: string) {
    return this.events.filter((e) => e.aggregate_id === aggregateId).map((e) => e.event_type);
  }
}

/** Sends one bank webhook to the API, signed, the way the bank's HTTP client would. */
async function deliverWebhook(event: BankWebhookEvent, secret = SECRET) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/webhooks/bank",
    headers: { "content-type": "application/json", [BANK_SIGNATURE_HEADER]: signBankWebhook(secret, body) },
    payload: body,
  });
}

let clock: number;
let bank: MockBank;
let downstream: Downstream;
let webhookOutcomes: string[];
let worker: OutboxWorker;
/** true: our webhook endpoint is "down" and every delivery fails. */
let endpointDown: boolean;

beforeEach(async () => {
  // Earlier test files leave events behind; settle them so we only see ours.
  await pool.query("UPDATE outbox SET status = 'published', published_at = now(), claim_token = NULL WHERE status <> 'published'");
  clock = Date.now();
  webhookOutcomes = [];
  endpointDown = false;
  downstream = new Downstream();
  bank = new MockBank({
    now: () => clock,
    behaviour: { settleAfterMs: 1_000 },
    deliver: async (event) => {
      if (endpointDown) throw new Error("connection refused");
      const res = await deliverWebhook(event);
      if (res.statusCode !== 200) throw new Error(`webhook answered ${res.statusCode}`);
      webhookOutcomes.push(res.json().outcome);
    },
  });
  worker = makeWorker();
});

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
  expect(await checkPayoutInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function makeWorker(opts: ConstructorParameters<typeof OutboxWorker>[2] = {}) {
  return new OutboxWorker(pool, routingPublisher({ [PAYOUT_SUBMIT_EVENT]: payoutSubmitter(pool, bank) }, downstream), {
    leaseMs: 5_000,
    publishTimeoutMs: 1_000,
    baseDelayMs: 5,
    maxDelayMs: 20,
    maxAttempts: 4,
    ...opts,
  });
}

function requestPayout(key: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/payouts", headers: { ...AS_OPERATOR, "idempotency-key": key }, payload: body });
}

async function payout(accountId: string, cents: number, accountNumber = SUCCEEDS): Promise<Payout> {
  const res = await requestPayout(randomUUID(), {
    account_id: accountId,
    amount_cents: cents,
    currency: "USD",
    bank_account_number: accountNumber,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const status = async (id: string) => (await getPayout(pool, id))!.status;

/** The bank's clock moves forward; it settles what is due and sends webhooks. */
async function advance(ms: number) {
  clock += ms;
  await bank.processDue();
}

async function submitEvent(payoutId: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
    "SELECT status, attempts, last_error FROM outbox WHERE aggregate_id = $1 AND event_type = $2",
    [payoutId, PAYOUT_SUBMIT_EVENT],
  );
  return rows[0];
}

/** Run the worker until the payout's submit event stops being retried (published or dead). */
async function driveSubmit(payoutId: string) {
  for (let i = 0; i < 200; i++) {
    await worker.drain();
    if ((await submitEvent(payoutId)).status !== "pending") return submitEvent(payoutId);
    await sleep(5);
  }
  throw new Error("submit event never settled");
}

async function postings(payoutId: string) {
  const { rows } = await pool.query<{ key: string; status: string }>(
    `SELECT idempotency_key AS key, status FROM transfers t
      WHERE idempotency_scope = 'system' AND idempotency_key LIKE $1
      ORDER BY (SELECT min(id) FROM ledger_entries e WHERE e.transfer_id = t.id)`,
    [`payout:${payoutId}:%`],
  );
  return rows.map((r) => r.key.split(":")[2]);
}

async function inFlight() {
  const { rows } = await pool.query<{ balance_cents: number }>(
    "SELECT balance_cents FROM accounts WHERE system_code = 'payouts_in_flight' AND currency = 'USD'",
  );
  return rows[0]?.balance_cents ?? 0;
}

describe("requesting a payout holds the money, in one transaction", () => {
  it("debits the user into 'Payouts in flight' and queues the payout for the bank; no bank call happens yet", async () => {
    const alice = await userWithBalance(5000);
    const before = await inFlight();
    const p = await payout(alice, 2000);

    expect(p.status).toBe("pending");
    expect(await balanceOf(alice)).toBe(3000);
    expect(await inFlight()).toBe(before + 2000);
    expect(await postings(p.id)).toEqual(["hold"]);
    expect(await submitEvent(p.id)).toMatchObject({ status: "pending" });
    expect(bank.createCalls).toBe(0);
  });

  it("without enough money it is rejected: nothing held, nothing sent, and a retry gets the same 422", async () => {
    const alice = await userWithBalance(1000);
    const key = randomUUID();
    const body = { account_id: alice, amount_cents: 1500, currency: "USD", bank_account_number: SUCCEEDS };
    const first = await requestPayout(key, body);
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ error: { code: "insufficient_funds" }, payout: { status: "rejected" } });

    await userWithBalance(0); // unrelated activity
    const retry = await requestPayout(key, body);
    expect(retry.statusCode).toBe(422);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await submitEvent(first.json().payout.id)).toBeUndefined();
    expect(await balanceOf(alice)).toBe(1000);
  });

  it("the same request twice (or 10× at once) creates one payout and one hold", async () => {
    const alice = await userWithBalance(5000);
    const key = randomUUID();
    const body = { account_id: alice, amount_cents: 700, currency: "USD", bank_account_number: SUCCEEDS };
    const results = await Promise.all(Array.from({ length: 10 }, () => requestPayout(key, body)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await balanceOf(alice)).toBe(4300);

    const reused = await requestPayout(key, { ...body, amount_cents: 701 });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("idempotency_key_reused");
  });

  it("10 simultaneous $10 payouts from a $50 account: exactly 5 are held, 5 rejected", async () => {
    const alice = await userWithBalance(5000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        requestPayout(randomUUID(), { account_id: alice, amount_cents: 1000, currency: "USD", bank_account_number: SUCCEEDS }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(5);
    expect(await balanceOf(alice)).toBe(0);
  });

  it("payouts come only from user accounts, and the account number must be digits", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE kind = 'system' LIMIT 1");
    const sys = await requestPayout(randomUUID(), { account_id: rows[0].id, amount_cents: 100, currency: "USD", bank_account_number: SUCCEEDS });
    expect(sys.statusCode).toBe(404);
    const alice = await userWithBalance(500);
    const bad = await requestPayout(randomUUID(), { account_id: alice, amount_cents: 100, currency: "USD", bank_account_number: "12ab" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("the happy path, and the bank's ordinary outcomes", () => {
  it("delayed success: submitted by the worker, settled by the webhook when the bank pays it out", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);

    await driveSubmit(p.id);
    const sent = (await getPayout(pool, p.id))!;
    expect(sent.status).toBe("submitted");
    expect(sent.provider_payout_id).toMatch(/^po_/);
    expect(bank.payouts()).toHaveLength(1);

    await advance(500); // not due yet
    expect(await status(p.id)).toBe("submitted");
    await advance(600);
    expect(webhookOutcomes).toEqual(["succeeded"]);
    expect(await status(p.id)).toBe("succeeded");
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
    expect(await balanceOf(alice)).toBe(3000);

    await worker.drain();
    expect(downstream.types(p.id)).toEqual(["payout.pending", "payout.submitted", "payout.succeeded"]);
  });

  it("the bank fails it later: the hold is reversed and the user gets the money back", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000, FAILS_LATER);
    await driveSubmit(p.id);
    expect(await balanceOf(alice)).toBe(3000);

    await advance(1_000);
    expect(await getPayout(pool, p.id)).toMatchObject({ status: "failed", failure_reason: "account_closed" });
    expect(await balanceOf(alice)).toBe(5000);
    // History is kept: the hold is not deleted, it is reversed by a new posting.
    expect(await postings(p.id)).toEqual(["hold", "reverse"]);
  });

  it("the bank refuses it outright (422): failed and reversed at once, and not retried", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000, REFUSED);
    const event = await driveSubmit(p.id);

    expect(event).toMatchObject({ status: "published", attempts: 1 });
    expect(await getPayout(pool, p.id)).toMatchObject({ status: "failed", failure_reason: "invalid_account_number" });
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("paid out, then returned by the receiving bank: the user is re-credited from 'Bank payouts'", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000, RETURNED);
    await driveSubmit(p.id);
    await advance(1_000);
    expect(await status(p.id)).toBe("succeeded");
    expect(await balanceOf(alice)).toBe(3000);

    await advance(1_000);
    expect(await getPayout(pool, p.id)).toMatchObject({ status: "returned", failure_reason: "account_frozen" });
    expect(await postings(p.id)).toEqual(["hold", "settle", "return"]);
    expect(await balanceOf(alice)).toBe(5000);
  });
});

describe("duplicate and misbehaving webhooks", () => {
  it("every webhook delivered 3 times: applied once, the other two are acknowledged as duplicates", async () => {
    bank.behaviour.webhookCopies = 3;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    await advance(1_000);

    expect(webhookOutcomes).toEqual(["succeeded", "duplicate", "duplicate"]);
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("the same webhook delivered 10 times at once is applied once", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    const bp = bank.payouts()[0];
    const event: BankWebhookEvent = { id: `evt_${randomUUID()}`, type: "payout.succeeded", created_at: new Date().toISOString(), data: { ...bp, status: "succeeded" } };

    const results = await Promise.all(Array.from({ length: 10 }, () => deliverWebhook(event)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    expect(results.map((r) => r.json().outcome).sort()).toEqual([...Array(9).fill("duplicate"), "succeeded"]);
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
  });

  it("two DIFFERENT events saying the same thing (the bank re-sent with a new id): the second changes nothing", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    await advance(1_000);
    bank.emit({ ...bank.payouts()[0] }, "payout.succeeded");
    await bank.flushWebhooks();

    expect(webhookOutcomes).toEqual(["succeeded", "no_change"]);
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
  });

  it("if our endpoint is down, the bank keeps the webhook and redelivers it later", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);

    endpointDown = true;
    await advance(1_000);
    expect(bank.pendingWebhooks()).toBe(1);
    expect(await status(p.id)).toBe("submitted");

    endpointDown = false;
    await bank.processDue();
    expect(await status(p.id)).toBe("succeeded");
    expect(bank.pendingWebhooks()).toBe(0);
  });

  it("rejects a bad signature, a tampered body and a stale timestamp, and records nothing", async () => {
    const event = { id: `evt_${randomUUID()}`, type: "payout.succeeded", created_at: new Date().toISOString(), data: {} };
    const body = JSON.stringify(event);
    const wrongSecret = await deliverWebhook(event as BankWebhookEvent, "not_the_secret");
    const tampered = await app.inject({
      method: "POST",
      url: "/webhooks/bank",
      headers: { "content-type": "application/json", [BANK_SIGNATURE_HEADER]: signBankWebhook(SECRET, body) },
      payload: body.replace("succeeded", "failed"),
    });
    const stale = await app.inject({
      method: "POST",
      url: "/webhooks/bank",
      headers: {
        "content-type": "application/json",
        [BANK_SIGNATURE_HEADER]: signBankWebhook(SECRET, body, Math.floor(Date.now() / 1000) - 3600),
      },
      payload: body,
    });
    expect([wrongSecret.statusCode, tampered.statusCode, stale.statusCode]).toEqual([400, 400, 400]);
    const { rowCount } = await pool.query("SELECT 1 FROM processed_events WHERE event_id = $1", [event.id]);
    expect(rowCount).toBe(0);
  });

  it("a webhook for a payout we don't know is recorded and acknowledged, not retried forever", async () => {
    const res = await deliverWebhook({
      id: `evt_${randomUUID()}`,
      type: "payout.succeeded",
      created_at: new Date().toISOString(),
      data: { id: "po_x", idempotency_key: "k", reference: randomUUID(), amount_cents: 1, currency: "USD", account_number: SUCCEEDS, status: "succeeded", failure_code: null, created_at: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ignored");
  });
});

describe("how we recover when the bank's state differs from ours", () => {
  it("the bank's response is lost: the retry sends the same key, and the bank pays out once", async () => {
    bank.behaviour.loseResponses = 1;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);

    const event = await driveSubmit(p.id);
    expect(event).toMatchObject({ status: "published", attempts: 2 });
    expect(bank.createCalls).toBe(2); // the bank saw both attempts...
    expect(bank.payouts()).toHaveLength(1); // ...and created one payout
    expect(bank.payouts()[0].idempotency_key).toBe(bankIdempotencyKey(p.id));

    await advance(1_000);
    expect(await status(p.id)).toBe("succeeded");
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("timeout, then the bank actually paid it out, and no webhook ever came: the status lookup settles it", async () => {
    // The bank accepts the payout, the response is lost, and then the bank
    // goes down, so every retry fails and the submit event runs out of
    // attempts. Webhooks are not arriving either. We think: pending. The bank
    // thinks: processing, and then succeeded.
    bank.behaviour.webhooksEnabled = false;
    bank.behaviour.loseResponses = 1;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);

    await worker.runOnce(); // attempt 1: accepted, response lost
    bank.behaviour.outage = true;
    expect(await driveSubmit(p.id)).toMatchObject({ status: "dead", attempts: 4 });
    expect(await status(p.id)).toBe("pending");
    expect(await balanceOf(alice)).toBe(3000); // held: not lost, not refunded on a guess

    await advance(1_000); // the bank pays it out; nobody tells us
    expect(bank.payouts()[0].status).toBe("succeeded");

    // While the bank is down, the reconciler can't ask, and changes nothing.
    expect((await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] })).unreachable).toBe(1);
    expect(await status(p.id)).toBe("pending");

    bank.behaviour.outage = false;
    const r = await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] });
    expect(r.outcomes[p.id]).toBe("succeeded");
    expect(await getPayout(pool, p.id)).toMatchObject({ status: "succeeded", provider_payout_id: bank.payouts()[0].id });
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
    expect(bank.payouts()).toHaveLength(1); // and we did not send it again
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("same, but the bank failed it: the status lookup reverses the hold", async () => {
    bank.behaviour.webhooksEnabled = false;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000, FAILS_LATER);
    await driveSubmit(p.id);
    await advance(1_000);
    expect(await status(p.id)).toBe("submitted");

    await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] });
    expect(await status(p.id)).toBe("failed");
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("an outage outlasts every retry and the bank never got it: the reconciler re-queues it, and it is paid once", async () => {
    bank.behaviour.outage = true;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    expect(await driveSubmit(p.id)).toMatchObject({ status: "dead", attempts: 4 });
    expect(bank.payouts()).toHaveLength(0);
    expect(await status(p.id)).toBe("pending");
    expect(await balanceOf(alice)).toBe(3000);

    bank.behaviour.outage = false;
    const r = await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] });
    expect(r.outcomes[p.id]).toBe("resubmitted");
    expect(await driveSubmit(p.id)).toMatchObject({ status: "published" });
    await advance(1_000);
    expect(await status(p.id)).toBe("succeeded");
    expect(bank.payouts()).toHaveLength(1);
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("the bank hasn't got it yet but a retry is still scheduled: the reconciler leaves it alone", async () => {
    bank.behaviour.outage = true;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await worker.runOnce(); // one failed attempt; the event is waiting to retry
    bank.behaviour.outage = false;

    const r = await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] });
    expect(r.outcomes[p.id]).toBe("in_progress");
    expect(await status(p.id)).toBe("pending"); // not failed on a guess
  });

  it("the webhook beats our own response: settled by the webhook, and the late retry changes nothing", async () => {
    // The bank settles instantly, sends its webhook, and our response is lost.
    bank.behaviour.settleAfterMs = 0;
    bank.behaviour.loseResponses = 1;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);

    await worker.runOnce(); // accepted, response lost
    await bank.processDue(); // webhook: succeeded
    expect(await status(p.id)).toBe("succeeded");

    await driveSubmit(p.id); // the retry finds nothing left to do
    expect(bank.createCalls).toBe(1);
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("out of order: 'returned' arrives before 'succeeded'; both postings happen once, in the right order", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000, RETURNED);
    await driveSubmit(p.id);
    const bp = bank.payouts()[0];
    const returned = await deliverWebhook({ id: `evt_${randomUUID()}`, type: "payout.returned", created_at: "", data: { ...bp, status: "returned" } });
    const succeeded = await deliverWebhook({ id: `evt_${randomUUID()}`, type: "payout.succeeded", created_at: "", data: { ...bp, status: "succeeded" } });

    expect([returned.json().outcome, succeeded.json().outcome]).toEqual(["returned", "no_change"]);
    expect(await postings(p.id)).toEqual(["hold", "settle", "return"]);
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("the bank contradicts itself (failed after succeeded): flagged for a person, and no money moves", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    await advance(1_000);
    expect(await status(p.id)).toBe("succeeded");

    bank.tamper(bankIdempotencyKey(p.id), { status: "failed", failure_code: "changed_its_mind" });
    bank.emit(bank.payouts()[0], "payout.failed");
    await bank.flushWebhooks();

    const after = (await getPayout(pool, p.id))!;
    expect(webhookOutcomes.at(-1)).toBe("discrepancy");
    expect(after.status).toBe("succeeded");
    expect(after.discrepancy).toContain("bank reports failed, we recorded succeeded");
    expect(await postings(p.id)).toEqual(["hold", "settle"]);
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("the bank reports a different amount: flagged, and nothing is settled or reversed", async () => {
    bank.behaviour.webhooksEnabled = false;
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    await advance(1_000);
    bank.tamper(bankIdempotencyKey(p.id), { amount_cents: 2500 });

    const r = await reconcilePayouts(pool, bank, { quietForMs: 0, ids: [p.id] });
    expect(r.outcomes[p.id]).toBe("discrepancy");
    expect(await getPayout(pool, p.id)).toMatchObject({ status: "submitted" });
    expect((await getPayout(pool, p.id))!.discrepancy).toContain("bank has 2500 USD, we have 2000 USD");
    expect(await postings(p.id)).toEqual(["hold"]);
  });

  it("the bank acknowledged a payout and then lost it: flagged, still held", async () => {
    const alice = await userWithBalance(5000);
    const p = await payout(alice, 2000);
    await driveSubmit(p.id);
    const forgetful = new MockBank(); // has no record of anything

    const r = await reconcilePayouts(pool, forgetful, { quietForMs: 0, ids: [p.id] });
    expect(r.outcomes[p.id]).toBe("missing_at_bank");
    expect((await getPayout(pool, p.id))!.discrepancy).toContain("no record of a payout it acknowledged");
    expect(await balanceOf(alice)).toBe(3000);
  });

  it("chaos: 30 payouts through lost responses, an outage, duplicate webhooks and no webhooks; every one ends where the bank says, once", async () => {
    const users = await Promise.all(Array.from({ length: 30 }, () => userWithBalance(1000)));
    const accounts = [SUCCEEDS, FAILS_LATER, REFUSED, RETURNED];
    const ps = await Promise.all(users.map((u, i) => payout(u, 400, accounts[i % accounts.length])));
    const ids = ps.map((p) => p.id);

    bank.behaviour.loseResponses = 8;
    bank.behaviour.webhookCopies = 2;
    await worker.runOnce();
    bank.behaviour.outage = true;
    await worker.runOnce();
    await sleep(30);
    await worker.runOnce();
    bank.behaviour.outage = false;
    bank.behaviour.webhooksEnabled = false; // the first round of outcomes is never announced
    for (const id of ids) await driveSubmit(id);
    await advance(1_000);
    bank.behaviour.webhooksEnabled = true;
    await advance(1_000); // returns are announced
    await reconcilePayouts(pool, bank, { quietForMs: 0, ids });
    for (const id of ids) if ((await submitEvent(id)).status === "pending") await driveSubmit(id);
    await advance(1_000);
    await reconcilePayouts(pool, bank, { quietForMs: 0, ids });

    const bankByRef = new Map(bank.payouts().map((b) => [b.reference, b]));
    expect(bank.payouts()).toHaveLength(30); // each paid (or refused) once, never twice
    for (const [i, id] of ids.entries()) {
      const ours = (await getPayout(pool, id))!;
      expect(ours.status).toBe(bankByRef.get(id)!.status);
      const expected = ours.status === "succeeded" ? 600 : 1000;
      expect(await balanceOf(users[i])).toBe(expected);
    }
  });
});

describe("over HTTP: the real API, the mock bank server, and the worker", () => {
  it("a payout travels API → outbox → bank → signed webhook → ledger, with a lost response and duplicate webhooks on the way", async () => {
    const { buildMockBankServer, httpWebhookDeliverer } = await import("../src/bank/mockBankServer.js");
    const { httpBankClient } = await import("../src/bank/client.js");
    const api = buildApp(pool, { ...operatorAuth, bankWebhookSecret: SECRET });
    const apiUrl = await api.listen({ port: 0, host: "127.0.0.1" });
    const remote = new MockBank({
      deliver: httpWebhookDeliverer(`${apiUrl}/webhooks/bank`, SECRET),
      behaviour: { settleAfterMs: 0, loseResponses: 1, webhookCopies: 2 },
    });
    const bankServer = buildMockBankServer(remote);
    const bankUrl = await bankServer.listen({ port: 0, host: "127.0.0.1" });
    const w = new OutboxWorker(pool, routingPublisher({ [PAYOUT_SUBMIT_EVENT]: payoutSubmitter(pool, httpBankClient(bankUrl)) }, downstream), {
      leaseMs: 5_000,
      publishTimeoutMs: 1_000,
      baseDelayMs: 5,
      maxDelayMs: 20,
    });
    try {
      const alice = await userWithBalance(5000);
      const res = await fetch(`${apiUrl}/payouts`, {
        method: "POST",
        headers: { ...AS_OPERATOR, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ account_id: alice, amount_cents: 1234, currency: "USD", bank_account_number: SUCCEEDS }),
      });
      const p = (await res.json()) as Payout;
      expect(res.status).toBe(201);

      for (let i = 0; i < 100 && (await submitEvent(p.id)).status === "pending"; i++) {
        await w.drain();
        await sleep(5);
      }
      expect(await submitEvent(p.id)).toMatchObject({ status: "published", attempts: 2 });
      await remote.processDue();

      const final = (await (await fetch(`${apiUrl}/payouts/${p.id}`, { headers: AS_OPERATOR })).json()) as Payout;
      expect(final.status).toBe("succeeded");
      expect(remote.payouts()).toHaveLength(1);
      expect(remote.deliveryLog.map((d) => d.ok)).toEqual([true, true]);
      expect(await balanceOf(alice)).toBe(5000 - 1234);
    } finally {
      await bankServer.close();
      await api.close();
    }
  });
});
