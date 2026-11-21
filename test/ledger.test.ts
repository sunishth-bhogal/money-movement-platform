import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db.js";
import { recordEventOnce } from "../src/ledger/events.js";
import { app, balanceOf, pool, postTransfer, usd, userWithBalance } from "./helpers.js";

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("ledger_entries is immutable", () => {
  it("refuses UPDATE, DELETE and TRUNCATE", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const t = (await postTransfer(randomUUID(), usd(alice, bob, 1000))).json();

    await expect(pool.query("UPDATE ledger_entries SET amount_cents = 1 WHERE transfer_id = $1", [t.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("DELETE FROM ledger_entries WHERE transfer_id = $1", [t.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("TRUNCATE ledger_entries CASCADE")).rejects.toThrow(/append-only/);
  });
});

describe("database-level invariants (defence in depth)", () => {
  it("refuses to commit entries that do not sum to zero", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const t = (await postTransfer(randomUUID(), usd(alice, bob, 1000))).json();

    // A buggy code path that writes only one leg.
    await expect(
      withTransaction(pool, (c) =>
        c.query("INSERT INTO ledger_entries (transfer_id, account_id, amount_cents, currency) VALUES ($1, $2, 500, 'USD')", [
          t.id,
          bob,
        ]),
      ),
    ).rejects.toThrow(/unbalanced transfer/);
    expect(await balanceOf(bob)).toBe(1000);
  });

  it("without row locks, a naive check-then-write would overspend; the CHECK constraint stops it", async () => {
    // Two $40 debits race against a $50 balance using a deliberately broken
    // implementation: read balance (no lock), pause, then write.
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);

    const naiveTransfer = (amount: number) =>
      withTransaction(
        pool,
        async (c) => {
          const { rows } = await c.query("SELECT balance_cents FROM accounts WHERE id = $1", [alice]); // no FOR UPDATE
          await c.query("SELECT pg_sleep(0.2)"); // widen the race window
          if (rows[0].balance_cents < amount) throw new Error("insufficient funds");
          const { rows: t } = await c.query(
            `INSERT INTO transfers (idempotency_key, request_hash, from_account_id, to_account_id, amount_cents, currency, status)
             VALUES ($1, 'x', $2, $3, $4, 'USD', 'posted') RETURNING id`,
            [randomUUID(), alice, bob, amount],
          );
          await c.query(
            `INSERT INTO ledger_entries (transfer_id, account_id, amount_cents, currency)
             VALUES ($1, $2, $3, 'USD'), ($1, $4, $5, 'USD')`,
            [t[0].id, alice, -amount, bob, amount],
          );
        },
        { maxAttempts: 1 },
      );

    const results = await Promise.allSettled([naiveTransfer(4000), naiveTransfer(4000)]);

    // Both passed the application check (both saw $50). The database rejected one.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.code).toBe("23514"); // check_violation
    expect(failure.reason.constraint).toBe("user_balance_non_negative");
    expect(await balanceOf(alice)).toBe(1000);
  });
});

describe("processed_events deduplicates external events", () => {
  const event = () => ({ provider: "test", eventId: `evt_${randomUUID()}`, type: "test.event", payload: { a: 1 } });

  it("a redelivered event is recognised as already processed", async () => {
    const e = event();
    expect(await withTransaction(pool, (c) => recordEventOnce(c, e))).toBe(true);
    expect(await withTransaction(pool, (c) => recordEventOnce(c, e))).toBe(false);
  });

  it("concurrent deliveries of the same event: exactly one wins", async () => {
    const e = event();
    const results = await Promise.all(Array.from({ length: 10 }, () => withTransaction(pool, (c) => recordEventOnce(c, e))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("if applying the event fails, the record rolls back so a redelivery is processed", async () => {
    const e = event();
    await expect(
      withTransaction(pool, async (c) => {
        await recordEventOnce(c, e);
        throw new Error("crash while applying the event");
      }),
    ).rejects.toThrow(/crash/);
    expect(await withTransaction(pool, (c) => recordEventOnce(c, e))).toBe(true);
  });
});
