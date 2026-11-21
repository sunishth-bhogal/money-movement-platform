import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { app, balanceOf, pool, postTransfer, usd, userWithBalance } from "./helpers.js";

afterEach(async () => {
  // After every scenario, the books must balance.
  expect(await checkLedgerInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function transferCount(key: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM transfers WHERE idempotency_key = $1", [key]);
  return rows[0].n;
}

describe("POST /transfers: happy path", () => {
  it("moves $10 with two balanced ledger entries", async () => {
    const alice = await userWithBalance(5000, "alice");
    const bob = await userWithBalance(0, "bob");

    const res = await postTransfer(randomUUID(), usd(alice, bob, 1000));

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "posted", amount_cents: 1000, from_account_id: alice, to_account_id: bob });
    expect(await balanceOf(alice)).toBe(4000);
    expect(await balanceOf(bob)).toBe(1000);

    const { rows } = await pool.query(
      "SELECT account_id, amount_cents FROM ledger_entries WHERE transfer_id = $1 ORDER BY amount_cents",
      [res.json().id],
    );
    expect(rows).toEqual([
      { account_id: alice, amount_cents: -1000 },
      { account_id: bob, amount_cents: 1000 },
    ]);
  });

  it("shows the transfer in each account's history", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const t = (await postTransfer(randomUUID(), usd(alice, bob, 1000))).json();

    const history = (await app.inject({ url: `/accounts/${bob}/entries` })).json().data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ transfer_id: t.id, amount_cents: 1000 });
  });
});

describe("POST /transfers: idempotency (duplicate requests)", () => {
  it("a retry after a lost response returns the original transfer and moves money once", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const key = randomUUID();

    // The first response "gets lost": the client never sees it and retries.
    const first = await postTransfer(key, usd(alice, bob, 1000));
    const retry = await postTransfer(key, usd(alice, bob, 1000));

    expect(retry.statusCode).toBe(first.statusCode);
    expect(retry.json()).toEqual(first.json());
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await transferCount(key)).toBe(1);
    expect(await balanceOf(alice)).toBe(4000);
    expect(await balanceOf(bob)).toBe(1000);
  });

  it("25 concurrent requests with the same key create exactly one transfer", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => postTransfer(key, usd(alice, bob, 1000))),
    );

    expect(responses.map((r) => r.statusCode)).toEqual(Array(25).fill(201));
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    expect(responses.filter((r) => r.headers["idempotent-replayed"] !== "true")).toHaveLength(1);
    expect(await transferCount(key)).toBe(1);
    expect(await balanceOf(alice)).toBe(4000);
    expect(await balanceOf(bob)).toBe(1000);
  });

  it("rejects reuse of a key with a different body, and changes nothing", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const key = randomUUID();
    await postTransfer(key, usd(alice, bob, 1000));

    const res = await postTransfer(key, usd(alice, bob, 2000));

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("idempotency_key_reused");
    expect(await balanceOf(alice)).toBe(4000);
  });

  it("replays a rejection too, even if funds arrive later (use a new key to try again)", async () => {
    const alice = await userWithBalance(500);
    const bob = await userWithBalance(0);
    const key = randomUUID();

    const first = await postTransfer(key, usd(alice, bob, 1000));
    expect(first.statusCode).toBe(422);
    expect(first.json().error.code).toBe("insufficient_funds");

    const topUp = await userWithBalance(5000);
    await postTransfer(randomUUID(), usd(topUp, alice, 5000));

    const retry = await postTransfer(key, usd(alice, bob, 1000));
    expect(retry.statusCode).toBe(422);
    expect(retry.json()).toEqual(first.json());
    expect(await balanceOf(bob)).toBe(0);

    const fresh = await postTransfer(randomUUID(), usd(alice, bob, 1000));
    expect(fresh.statusCode).toBe(201);
  });
});

describe("POST /transfers: concurrency (no overspending, no deadlocks)", () => {
  it("20 simultaneous $10 transfers from a $50 account: exactly 5 succeed", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => postTransfer(randomUUID(), usd(alice, bob, 1000))),
    );

    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes.filter((c) => c === 422)).toHaveLength(15);
    expect(await balanceOf(alice)).toBe(0);
    expect(await balanceOf(bob)).toBe(5000);
  });

  it("transfers in opposite directions between the same two accounts do not deadlock", async () => {
    const a = await userWithBalance(10_000);
    const b = await userWithBalance(10_000);

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? postTransfer(randomUUID(), usd(a, b, 100)) : postTransfer(randomUUID(), usd(b, a, 100)),
      ),
    );

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(await balanceOf(a)).toBe(10_000);
    expect(await balanceOf(b)).toBe(10_000);
  });

  it("a ring of concurrent transfers (A->B->C->A) conserves money", async () => {
    const [a, b, c] = await Promise.all([userWithBalance(3000), userWithBalance(3000), userWithBalance(3000)]);
    const pairs: [string, string][] = [[a, b], [b, c], [c, a]];

    await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const [from, to] = pairs[i % 3];
        return postTransfer(randomUUID(), usd(from, to, 100));
      }),
    );

    expect((await balanceOf(a)) + (await balanceOf(b)) + (await balanceOf(c))).toBe(9000);
  });
});

describe("POST /transfers: validation", () => {
  it("requires an Idempotency-Key header", async () => {
    const res = await postTransfer(undefined, usd(randomUUID(), randomUUID(), 1000));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it.each([
    ["a float amount", 10.5],
    ["a zero amount", 0],
    ["a negative amount", -1000],
    ["a string amount", "1000"],
  ])("rejects %s", async (_label, amount) => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const res = await postTransfer(randomUUID(), { ...usd(alice, bob, 0), amount_cents: amount });
    expect(res.statusCode).toBe(400);
    expect(await balanceOf(alice)).toBe(5000);
  });

  it("rejects a transfer to the same account", async () => {
    const alice = await userWithBalance(5000);
    const res = await postTransfer(randomUUID(), usd(alice, alice, 1000));
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown account and does not consume the key", async () => {
    const alice = await userWithBalance(5000);
    const key = randomUUID();
    const res = await postTransfer(key, usd(alice, randomUUID(), 1000));
    expect(res.statusCode).toBe(404);
    expect(await transferCount(key)).toBe(0);
  });

  it("rejects a currency that does not match the accounts", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const res = await postTransfer(randomUUID(), { ...usd(alice, bob, 1000), currency: "EUR" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("currency_mismatch");
  });
});
