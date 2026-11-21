import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { applyProviderState, checkPayoutInvariants } from "../src/payouts/payouts.js";
import { issueSessionToken, verifySessionToken } from "../src/wallet/auth.js";
import { loadWalletConfig } from "../src/wallet/config.js";
import { MockBank } from "../src/bank/mockBank.js";
import { buildMockBankServer } from "../src/bank/mockBankServer.js";
import { balanceOf, pool, userWithBalance } from "./helpers.js";

const SECRET = "test-wallet-secret";

// The demo configuration: wallet on, deposits through the demo checkout
// (signed events through the real /webhooks/stripe), no Stripe account.
const config = loadWalletConfig(
  { appBaseUrl: "http://localhost:3000" },
  { WALLET_SESSION_SECRET: SECRET, DEMO_MODE: "true" },
);
const app = buildApp(pool, { payments: config.payments, wallet: config.wallet });

afterAll(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
  expect(await checkPayoutInvariants(pool)).toEqual([]);
  await app.close();
  await pool.end();
});

interface Item {
  id: string;
  kind: string;
  object_id: string;
  title: string;
  state: "pending" | "settled" | "failed";
  status: string;
  status_label: string;
  amount_cents: number;
  balance_effect_cents: number;
  counterparty: { id: string; name: string } | null;
}

async function signIn(accountId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/me/session", payload: { account_id: accountId } });
  expect(res.statusCode).toBe(201);
  return res.json().token;
}

function call(token: string, method: "GET" | "POST", url: string, payload?: object, key?: string) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function activity(token: string): Promise<Item[]> {
  const res = await call(token, "GET", "/me/activity?limit=200");
  expect(res.statusCode).toBe(200);
  return res.json().data;
}

async function user(cents: number, name = "user") {
  const id = await userWithBalance(cents, name);
  return { id, token: await signIn(id) };
}

describe("demo sign-in", () => {
  it("issues a token for a user account and refuses system accounts and unknown ids", async () => {
    const alice = await user(0, "Alice");
    const me = await call(alice.token, "GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().account).toMatchObject({ id: alice.id, name: "Alice", currency: "USD" });

    const { rows } = await pool.query("INSERT INTO accounts (name, currency, kind) VALUES ('sys', 'USD', 'system') RETURNING id");
    expect((await app.inject({ method: "POST", url: "/me/session", payload: { account_id: rows[0].id } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/me/session", payload: { account_id: randomUUID() } })).statusCode).toBe(404);
  });

  it("rejects a missing, forged, tampered or expired token", async () => {
    const alice = await user(0);
    const bob = await user(0);
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await call("nonsense", "GET", "/me")).statusCode).toBe(401);
    // Swap the account id inside Alice's token for Bob's: the signature no longer matches.
    const [, exp, mac] = alice.token.split(".");
    expect((await call(`${Buffer.from(bob.id).toString("base64url")}.${exp}.${mac}`, "GET", "/me")).statusCode).toBe(401);
    // Signed with a different secret.
    expect((await call(issueSessionToken("other-secret", alice.id).token, "GET", "/me")).statusCode).toBe(401);
    // Expired.
    const old = issueSessionToken(SECRET, alice.id, Date.now() - 13 * 60 * 60 * 1000).token;
    expect(verifySessionToken(SECRET, old)).toBeNull();
    expect((await call(old, "GET", "/me")).statusCode).toBe(401);
  });

  it("answers 503 when no session secret is configured", async () => {
    const off = buildApp(pool);
    expect((await off.inject({ method: "GET", url: "/me/demo-users" })).statusCode).toBe(503);
    await off.close();
  });

  it("reports what the demo has switched on", async () => {
    const res = await app.inject({ method: "GET", url: "/me/config" });
    expect(res.json()).toEqual({ sign_in: "demo", deposits: "demo_checkout", bank_controls: false });
  });
});

describe("transfers from the wallet", () => {
  it("a double-click (two requests, one key) moves money once", async () => {
    const alice = await user(5000, "Alice");
    const bob = await user(0, "Bob");
    const key = randomUUID();
    const body = { to_account_id: bob.id, amount_cents: 1250 };
    const [a, b] = await Promise.all([
      call(alice.token, "POST", "/me/transfers", body, key),
      call(alice.token, "POST", "/me/transfers", body, key),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().item.object_id).toBe(b.json().item.object_id);
    expect([a.json().replayed, b.json().replayed].sort()).toEqual([false, true]);
    expect([a.headers["idempotent-replayed"], b.headers["idempotent-replayed"]]).toContain("true");

    // A third click after the response, same key: still the same transfer.
    const c = await call(alice.token, "POST", "/me/transfers", body, key);
    expect(c.json()).toMatchObject({ replayed: true, item: { object_id: a.json().item.object_id } });

    expect(await balanceOf(alice.id)).toBe(3750);
    expect(await balanceOf(bob.id)).toBe(1250);
    const sent = (await activity(alice.token)).filter((i) => i.kind === "transfer_out");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Sent to Bob", state: "settled", balance_effect_cents: -1250 });
    expect((await activity(bob.token)).find((i) => i.kind === "transfer_in")).toMatchObject({
      title: "Received from Alice",
      state: "settled",
      balance_effect_cents: 1250,
      counterparty: { id: alice.id, name: "Alice" },
    });
  });

  it("25 concurrent clicks with one key post one transfer", async () => {
    const alice = await user(5000);
    const bob = await user(0);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 100 }, key)),
    );
    expect(new Set(results.map((r) => r.statusCode))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.json().item.object_id)).size).toBe(1);
    expect(results.filter((r) => !r.json().replayed)).toHaveLength(1);
    expect(await balanceOf(bob.id)).toBe(100);
  });

  it("keys are per user: the same key from two users is two transfers", async () => {
    const alice = await user(1000);
    const bob = await user(1000);
    const key = "shared-key-123";
    const a = await call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 100 }, key);
    const b = await call(bob.token, "POST", "/me/transfers", { to_account_id: alice.id, amount_cents: 300 }, key);
    expect(a.json().replayed).toBe(false);
    expect(b.json().replayed).toBe(false);
    expect(await balanceOf(alice.id)).toBe(1200);
    expect(await balanceOf(bob.id)).toBe(800);
  });

  it("the same key with a different amount is refused, not guessed", async () => {
    const alice = await user(1000);
    const bob = await user(0);
    const key = randomUUID();
    await call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 100 }, key);
    const res = await call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 999 }, key);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("idempotency_key_reused");
    expect(await balanceOf(bob.id)).toBe(100);
  });

  it("an overdraft is shown to the sender as failed, and not at all to the recipient", async () => {
    const carol = await user(500);
    const dave = await user(0);
    const res = await call(carol.token, "POST", "/me/transfers", { to_account_id: dave.id, amount_cents: 501 }, randomUUID());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: "insufficient_funds" },
      item: { state: "failed", status_label: "Not enough money", balance_effect_cents: 0 },
    });
    expect((await activity(carol.token)).filter((i) => i.kind === "transfer_out")).toHaveLength(1);
    expect((await activity(dave.token)).filter((i) => i.kind === "transfer_in")).toHaveLength(0);
    expect(await balanceOf(carol.id)).toBe(500);
  });

  it("always sends from the signed-in account, and refuses system accounts and yourself", async () => {
    const alice = await user(1000);
    const bob = await user(1000);
    // A from_account_id in the body is ignored (not part of the schema): the money comes from Alice, not Bob.
    const res = await call(alice.token, "POST", "/me/transfers", { from_account_id: bob.id, to_account_id: bob.id, amount_cents: 1 }, randomUUID());
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(bob.id)).toBe(1001);
    const self = await call(alice.token, "POST", "/me/transfers", { to_account_id: alice.id, amount_cents: 1 }, randomUUID());
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe("same_account");

    const { rows } = await pool.query("INSERT INTO accounts (name, currency, kind) VALUES ('sys', 'USD', 'system') RETURNING id");
    const sys = await call(alice.token, "POST", "/me/transfers", { to_account_id: rows[0].id, amount_cents: 1 }, randomUUID());
    expect(sys.statusCode).toBe(403);
    expect((await call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 1 })).statusCode).toBe(400);
    expect((await call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: 1.5 }, randomUUID())).statusCode).toBe(400);
    expect(await balanceOf(alice.id)).toBe(999);
  });

  it("lists the other users as payees", async () => {
    const alice = await user(0, "Payee-test-Alice");
    const bob = await user(0, "Payee-test-Bob");
    const payees: { id: string }[] = (await call(alice.token, "GET", "/me/payees")).json().data;
    expect(payees.map((p) => p.id)).toContain(bob.id);
    expect(payees.map((p) => p.id)).not.toContain(alice.id);
  });
});

describe("deposits through the demo checkout", () => {
  async function startDeposit(token: string, amount_cents = 2500, key: string = randomUUID()) {
    const res = await call(token, "POST", "/me/deposits", { amount_cents }, key);
    expect(res.statusCode).toBe(201);
    return res.json() as { item: Item; replayed: boolean; checkout_url: string };
  }

  it("stays pending until the (signed) webhook arrives, then settles once even if delivered twice", async () => {
    const alice = await user(0);
    const key = randomUUID();
    const started = await startDeposit(alice.token, 2500, key);
    expect(started.item).toMatchObject({ kind: "deposit", state: "pending", status: "pending", balance_effect_cents: 0 });
    expect(started.checkout_url).toBe(`http://localhost:3000/wallet/?demo_checkout=${started.item.object_id}`);
    expect((await call(alice.token, "GET", "/me")).json().incoming_cents).toBe(2500);

    // Clicking "Add funds" twice opens the same checkout.
    const again = await startDeposit(alice.token, 2500, key);
    expect(again).toMatchObject({ replayed: true, item: { object_id: started.item.object_id } });

    const paid = await call(alice.token, "POST", `/me/deposits/${started.item.object_id}/demo-checkout`, { outcome: "pay_duplicate_webhook" });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().deliveries.map((d: { status: number; outcome: string }) => [d.status, d.outcome])).toEqual([
      [200, "deposit_succeeded"],
      [200, "duplicate"],
    ]);
    expect(paid.json().item).toMatchObject({ state: "settled", balance_effect_cents: 2500 });
    expect(await balanceOf(alice.id)).toBe(2500);
    expect((await call(alice.token, "GET", "/me")).json()).toMatchObject({ available_cents: 2500, incoming_cents: 0 });
  });

  it("shows a failed bank debit and an abandoned checkout as failed, with no money moved", async () => {
    const alice = await user(0);
    const debit = await startDeposit(alice.token, 1000);
    const failed = await call(alice.token, "POST", `/me/deposits/${debit.item.object_id}/demo-checkout`, { outcome: "bank_debit_fails" });
    expect(failed.json().deliveries.map((d: { outcome: string }) => d.outcome)).toEqual(["deposit_processing", "deposit_failed"]);
    expect(failed.json().item).toMatchObject({ state: "failed", status_label: "Payment failed" });

    const left = await startDeposit(alice.token, 700);
    const abandoned = await call(alice.token, "POST", `/me/deposits/${left.item.object_id}/demo-checkout`, { outcome: "abandon" });
    expect(abandoned.json().item).toMatchObject({ state: "failed", status: "expired", status_label: "Checkout abandoned" });

    // Paying after the fact is too late: the deposit is final.
    const late = await call(alice.token, "POST", `/me/deposits/${left.item.object_id}/demo-checkout`, { outcome: "pay" });
    expect(late.json().deliveries[0].outcome).toBe("already_final");
    expect(await balanceOf(alice.id)).toBe(0);
  });

  it("only the deposit's owner can see or complete it", async () => {
    const alice = await user(0);
    const mallory = await user(0);
    const d = await startDeposit(alice.token);
    expect((await call(mallory.token, "GET", `/me/deposits/${d.item.object_id}`)).statusCode).toBe(404);
    expect((await call(mallory.token, "POST", `/me/deposits/${d.item.object_id}/demo-checkout`, { outcome: "pay" })).statusCode).toBe(404);
    expect((await call(alice.token, "GET", `/me/deposits/${d.item.object_id}`)).json().state).toBe("pending");
  });

  it("is not offered when demo mode is off", async () => {
    const plain = loadWalletConfig({ appBaseUrl: "http://localhost:3000" }, { WALLET_SESSION_SECRET: SECRET });
    const off = buildApp(pool, { payments: plain.payments, wallet: plain.wallet });
    const alice = await userWithBalance(0);
    const token = (await off.inject({ method: "POST", url: "/me/session", payload: { account_id: alice } })).json().token;
    const res = await off.inject({
      method: "POST",
      url: "/me/deposits",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { amount_cents: 100 },
    });
    expect(res.statusCode).toBe(503);
    expect((await off.inject({ method: "GET", url: "/me/config" })).json().deposits).toBe("disabled");
    await off.close();
  });
});

describe("payouts from the wallet", () => {
  async function bankSays(payoutId: string, status: "processing" | "succeeded" | "failed" | "returned", amount: number) {
    await withTransaction(pool, (c) =>
      applyProviderState(c, payoutId, { id: `bank_${payoutId}`, status, amount_cents: amount, currency: "USD", failure_code: null }, "webhook"),
    );
  }

  it("holds the money while pending, then settles, or fails and refunds", async () => {
    const alice = await user(10_000);
    const ok = await call(alice.token, "POST", "/me/payouts", { amount_cents: 3000, bank_account_number: "000123451111" }, randomUUID());
    expect(ok.statusCode).toBe(201);
    const okId = ok.json().item.object_id;
    expect(ok.json().item).toMatchObject({ title: "Withdrawal to bank ••1111", state: "pending", balance_effect_cents: -3000 });
    expect((await call(alice.token, "GET", "/me")).json()).toMatchObject({ available_cents: 7000, on_hold_cents: 3000 });

    const bad = await call(alice.token, "POST", "/me/payouts", { amount_cents: 2000, bank_account_number: "000123450002" }, randomUUID());
    const badId = bad.json().item.object_id;

    await bankSays(okId, "processing", 3000);
    await bankSays(okId, "succeeded", 3000);
    await bankSays(badId, "failed", 2000);

    const items = await activity(alice.token);
    expect(items.find((i) => i.object_id === okId)).toMatchObject({ state: "settled", status_label: "Paid out", balance_effect_cents: -3000 });
    expect(items.find((i) => i.object_id === badId)).toMatchObject({
      state: "failed",
      status_label: "Bank failed it, refunded",
      balance_effect_cents: 0,
    });
    expect((await call(alice.token, "GET", "/me")).json()).toMatchObject({ available_cents: 7000, on_hold_cents: 0 });

    // The statement shows every posting behind those two rows, with a running balance.
    const lines = (await call(alice.token, "GET", "/me/statement")).json().data;
    expect(lines.map((l: { description: string; amount_cents: number; balance_after_cents: number }) => [l.description, l.amount_cents, l.balance_after_cents])).toEqual([
      ["Withdrawal failed: hold released", 2000, 7000],
      ["Withdrawal: money held for the bank", -2000, 5000],
      ["Withdrawal: money held for the bank", -3000, 7000],
      ["Account funding", 10_000, 10_000],
    ]);
    expect(lines[0].activity_id).toBe(`payout:${badId}`);
  });

  it("a double-clicked withdrawal holds the money once", async () => {
    const alice = await user(5000);
    const key = randomUUID();
    const body = { amount_cents: 4000, bank_account_number: "000123451111" };
    const [a, b] = await Promise.all([call(alice.token, "POST", "/me/payouts", body, key), call(alice.token, "POST", "/me/payouts", body, key)]);
    expect(a.json().item.object_id).toBe(b.json().item.object_id);
    expect(await balanceOf(alice.id)).toBe(1000);
  });

  it("refuses a withdrawal larger than the balance", async () => {
    const alice = await user(100);
    const res = await call(alice.token, "POST", "/me/payouts", { amount_cents: 101, bank_account_number: "000123451111" }, randomUUID());
    expect(res.statusCode).toBe(422);
    expect(res.json().item).toMatchObject({ state: "failed", status: "rejected", balance_effect_cents: 0 });
    expect(await balanceOf(alice.id)).toBe(100);
  });
});

describe("activity feed", () => {
  it("pages newest first without skipping or repeating items", async () => {
    const alice = await user(100_000);
    const bob = await user(0);
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        call(alice.token, "POST", "/me/transfers", { to_account_id: bob.id, amount_cents: n + 1 }, randomUUID()),
      ),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(alice.token, "GET", `/me/activity?limit=5${cursor ? `&before=${cursor}` : ""}`);
      const page: { data: Item[]; next_cursor: string | null } = res.json();
      seen.push(...page.data.map((i) => i.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(13); // 12 transfers + the funding
    expect(new Set(seen).size).toBe(13);
    expect(seen[seen.length - 1]).toMatch(/^adjustment:/);
    expect((await call(alice.token, "GET", "/me/activity?before=garbage")).statusCode).toBe(400);
  });
});

describe("demo bank controls", () => {
  it("lets a signed-in user flip the mock bank's switches, and nothing else", async () => {
    const bank = buildMockBankServer(new MockBank({}));
    const url = await bank.listen({ port: 0, host: "127.0.0.1" });
    const cfg = loadWalletConfig({ appBaseUrl: "http://localhost:3000" }, { WALLET_SESSION_SECRET: SECRET, DEMO_MODE: "true", BANK_API_URL: url });
    const demo = buildApp(pool, { payments: cfg.payments, wallet: cfg.wallet });
    try {
      expect((await demo.inject({ method: "GET", url: "/me/config" })).json().bank_controls).toBe(true);
      expect((await demo.inject({ method: "GET", url: "/me/demo/bank" })).statusCode).toBe(401);
      const id = await userWithBalance(0);
      const token = (await demo.inject({ method: "POST", url: "/me/session", payload: { account_id: id } })).json().token;
      const auth = { authorization: `Bearer ${token}` };
      const set = await demo.inject({ method: "POST", url: "/me/demo/bank", headers: auth, payload: { outage: true, webhookCopies: 2 } });
      expect(set.json().behaviour).toMatchObject({ outage: true, webhookCopies: 2 });
      expect((await demo.inject({ method: "GET", url: "/me/demo/bank", headers: auth })).json().behaviour.outage).toBe(true);
      // Only the listed switches: e.g. the settlement delay is not the user's to change.
      expect((await demo.inject({ method: "POST", url: "/me/demo/bank", headers: auth, payload: { webhookCopies: 50 } })).statusCode).toBe(400);
    } finally {
      await demo.close();
      await bank.close();
    }
  });
});
