import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { issueSessionToken } from "../src/wallet/auth.js";
import { AS_OPERATOR, balanceOf, OPERATOR_TOKEN, pool, usd, userWithBalance } from "./helpers.js";

// Who may call the core API (/accounts, /transfers, /deposits, /payouts):
// an operator with ADMIN_TOKEN, or a signed-in user acting on their own account.

const SESSION_SECRET = "test-session-secret";
const app = buildApp(pool, {
  admin: { token: OPERATOR_TOKEN, providers: {} },
  wallet: { sessionSecret: SESSION_SECRET },
  payments: {
    gateway: { createCheckoutSession: async (_i, key: string) => ({ id: `cs_test_${key.replaceAll(":", "_")}`, url: "https://checkout.stripe.com/c/pay/x" }) },
    appBaseUrl: "http://localhost:3000",
  },
});

const asUser = (accountId: string) => ({ authorization: `Bearer ${issueSessionToken(SESSION_SECRET, accountId).token}` });

function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, payload?: object) {
  return app.inject({ method, url, headers: { "idempotency-key": randomUUID(), ...headers }, payload });
}

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("every core route needs a caller", () => {
  it("no token, a wrong token, a forged or expired session: 401, and nothing happens", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const forged = issueSessionToken("someone-elses-secret", alice).token;
    const expired = issueSessionToken(SESSION_SECRET, alice, Date.now() - 13 * 60 * 60 * 1000).token;

    for (const headers of [{} as Record<string, string>, { authorization: "Bearer nope" }, { authorization: `Bearer ${forged}` }, { authorization: `Bearer ${expired}` }]) {
      const results = await Promise.all([
        call("POST", "/accounts", headers, { name: "x", currency: "USD" }),
        call("GET", `/accounts/${alice}`, headers),
        call("GET", `/accounts/${alice}/entries`, headers),
        call("POST", "/transfers", headers, usd(alice, bob, 100)),
        call("GET", `/transfers/${randomUUID()}`, headers),
        call("POST", "/deposits", headers, { account_id: alice, amount_cents: 100, currency: "USD" }),
        call("POST", "/payouts", headers, { account_id: alice, amount_cents: 100, currency: "USD", bank_account_number: "000123451111" }),
        call("GET", `/payouts/${randomUUID()}`, headers),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(401));
    }
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("with neither ADMIN_TOKEN nor WALLET_SESSION_SECRET set, nobody can sign in: 503", async () => {
    const off = buildApp(pool);
    const res = await off.inject({ method: "GET", url: `/accounts/${randomUUID()}`, headers: AS_OPERATOR });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth_not_configured");
    await off.close();
  });

  it("health and the signed webhooks stay open (they have their own checks)", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("a signed-in user acts only on their own account", () => {
  it("sends money from their own account, and both sides can look it up; nobody else can", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const carol = await userWithBalance(0);

    const sent = await call("POST", "/transfers", asUser(alice), usd(alice, bob, 700));
    expect(sent.statusCode).toBe(201);
    const id = sent.json().id;

    expect((await call("GET", `/transfers/${id}`, asUser(alice))).statusCode).toBe(200);
    expect((await call("GET", `/transfers/${id}`, asUser(bob))).statusCode).toBe(200);
    expect((await call("GET", `/transfers/${id}`, asUser(carol))).statusCode).toBe(404);
    expect((await call("GET", `/transfers/${id}`, AS_OPERATOR)).statusCode).toBe(200);
  });

  it("cannot move money out of someone else's account by changing from_account_id", async () => {
    const alice = await userWithBalance(5000);
    const mallory = await userWithBalance(0);

    const res = await call("POST", "/transfers", asUser(mallory), usd(alice, mallory, 5000));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(await balanceOf(alice)).toBe(5000);
    expect(await balanceOf(mallory)).toBe(0);
  });

  it("cannot withdraw from, or start a deposit into, someone else's account", async () => {
    const alice = await userWithBalance(5000);
    const mallory = await userWithBalance(0);

    const payout = await call("POST", "/payouts", asUser(mallory), {
      account_id: alice,
      amount_cents: 5000,
      currency: "USD",
      bank_account_number: "000123451111",
    });
    expect(payout.statusCode).toBe(403);
    const deposit = await call("POST", "/deposits", asUser(mallory), { account_id: alice, amount_cents: 100, currency: "USD" });
    expect(deposit.statusCode).toBe(403);
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("sees their own account, payouts and deposits; anyone else's is a 404, as if it did not exist", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);

    const payout = await call("POST", "/payouts", asUser(alice), {
      account_id: alice,
      amount_cents: 1000,
      currency: "USD",
      bank_account_number: "000123451111",
    });
    expect(payout.statusCode).toBe(201);
    const deposit = await call("POST", "/deposits", asUser(alice), { account_id: alice, amount_cents: 2500, currency: "USD" });
    expect(deposit.statusCode).toBe(201);

    for (const url of [`/accounts/${alice}`, `/accounts/${alice}/entries`, `/payouts/${payout.json().id}`, `/deposits/${deposit.json().id}`]) {
      expect([url, (await call("GET", url, asUser(alice))).statusCode]).toEqual([url, 200]);
      expect([url, (await call("GET", url, asUser(bob))).statusCode]).toEqual([url, 404]);
      expect([url, (await call("GET", url, AS_OPERATOR)).statusCode]).toEqual([url, 200]);
    }
  });

  it("cannot create accounts: that is an operator's job", async () => {
    const alice = await userWithBalance(0);
    expect((await call("POST", "/accounts", asUser(alice), { name: "x", currency: "USD" })).statusCode).toBe(403);
    expect((await call("POST", "/accounts", AS_OPERATOR, { name: "x", currency: "USD" })).statusCode).toBe(201);
  });

  it("Idempotency-Keys are per user: the same key from two users is two transfers, and nobody replays anyone else's", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(5000);
    const key = `shared-${randomUUID()}`;

    const a = await call("POST", "/transfers", { ...asUser(alice), "idempotency-key": key }, usd(alice, bob, 100));
    const b = await call("POST", "/transfers", { ...asUser(bob), "idempotency-key": key }, usd(bob, alice, 300));
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().id).not.toBe(b.json().id);
    expect(b.headers["idempotent-replayed"]).toBeUndefined();

    // Alice's own retry is still a replay.
    const again = await call("POST", "/transfers", { ...asUser(alice), "idempotency-key": key }, usd(alice, bob, 100));
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().id).toBe(a.json().id);
    expect([await balanceOf(alice), await balanceOf(bob)]).toEqual([5200, 4800]);
  });
});

describe("the Checkout return page", () => {
  it("without credentials it shows only the deposit's status, which is all a returning browser needs", async () => {
    const alice = await userWithBalance(0);
    const deposit = await call("POST", "/deposits", asUser(alice), { account_id: alice, amount_cents: 2500, currency: "USD" });
    const page = await app.inject({ method: "GET", url: `/deposits/${deposit.json().id}?checkout=success` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ id: deposit.json().id, status: "pending" });
    // A bad token is still refused rather than treated as "no credentials".
    const bad = await app.inject({ method: "GET", url: `/deposits/${deposit.json().id}`, headers: { authorization: "Bearer nope" } });
    expect(bad.statusCode).toBe(401);
  });
});
