import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { createTransferInTx } from "../src/ledger/transfers.js";
import { enqueueOutboxEvent, requeueDeadEvent, type OutboxEvent } from "../src/outbox/outbox.js";
import { httpPublisher } from "../src/outbox/publishers.js";
import { backoffDelayMs, OutboxWorker, PermanentPublishError, type Publisher } from "../src/outbox/worker.js";
import { app, balanceOf, pool, postTransfer, usd, userWithBalance } from "./helpers.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A downstream system. Records every delivery it accepts, and applies each
 * event id at most once, the way a well-behaved consumer must when delivery is
 * at-least-once.
 */
class FakeDestination implements Publisher {
  deliveries: { eventId: string; at: number; attempt: number }[] = [];
  applied = new Set<string>();
  /** Decides each delivery: return normally to accept it, throw to fail it. */
  behaviour: (event: OutboxEvent, signal: AbortSignal) => Promise<void> | void = () => {};

  async publish(event: OutboxEvent, signal: AbortSignal) {
    await this.behaviour(event, signal);
    this.deliveries.push({ eventId: event.event_id, at: Date.now(), attempt: event.attempts });
    this.applied.add(event.event_id); // a Set: a redelivery is a no-op
  }

  deliveriesOf(eventId: string) {
    return this.deliveries.filter((d) => d.eventId === eventId);
  }
}

let dest: FakeDestination;

beforeEach(async () => {
  dest = new FakeDestination();
  // Other test files leave pending events behind. Settle them so each test
  // here only sees the events it creates.
  await pool.query("UPDATE outbox SET status = 'published', published_at = now(), claim_token = NULL WHERE status <> 'published'");
});

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function worker(opts: ConstructorParameters<typeof OutboxWorker>[2] = {}) {
  return new OutboxWorker(pool, dest, { leaseMs: 5_000, publishTimeoutMs: 1_000, baseDelayMs: 10, ...opts });
}

async function enqueue(n = 1): Promise<string[]> {
  const { rows } = await pool.query<{ event_id: string }>(
    `INSERT INTO outbox (event_type, aggregate_type, aggregate_id, payload)
     SELECT 'test.event', 'transfer', gen_random_uuid(), jsonb_build_object('n', i)
       FROM generate_series(1, $1) AS i
     RETURNING event_id`,
    [n],
  );
  return rows.map((r) => r.event_id);
}

async function row(eventId: string) {
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null; claim_token: string | null }>(
    "SELECT status, attempts, last_error, claim_token FROM outbox WHERE event_id = $1",
    [eventId],
  );
  return rows[0];
}

async function eventsFor(aggregateId: string) {
  const { rows } = await pool.query<{ event_id: string; event_type: string }>(
    "SELECT event_id, event_type FROM outbox WHERE aggregate_id = $1 ORDER BY id",
    [aggregateId],
  );
  return rows;
}

describe("writing to the outbox is part of the money movement's transaction", () => {
  it("a posted transfer writes exactly one transfer.posted event, a rejected one writes transfer.rejected", async () => {
    const alice = await userWithBalance(1000);
    const bob = await userWithBalance(0);
    const posted = (await postTransfer(randomUUID(), usd(alice, bob, 600))).json();
    const rejected = (await postTransfer(randomUUID(), usd(alice, bob, 600))).json().transfer;

    expect((await eventsFor(posted.id)).map((e) => e.event_type)).toEqual(["transfer.posted"]);
    expect((await eventsFor(rejected.id)).map((e) => e.event_type)).toEqual(["transfer.rejected"]);
  });

  it("if the transaction rolls back, neither the transfer nor its event exists", async () => {
    const alice = await userWithBalance(1000);
    const bob = await userWithBalance(0);
    const key = randomUUID();
    let transferId = "";

    await expect(
      withTransaction(pool, async (client) => {
        const { transfer } = await createTransferInTx(client, key, usd(alice, bob, 400));
        transferId = transfer.id;
        expect(await eventsFor(transfer.id)).toHaveLength(0); // invisible outside the transaction...
        throw new Error("crash before COMMIT");
      }),
    ).rejects.toThrow("crash before COMMIT");

    expect(await eventsFor(transferId)).toHaveLength(0); // ...and gone with it
    expect((await pool.query("SELECT 1 FROM transfers WHERE idempotency_key = $1", [key])).rowCount).toBe(0);
    expect(await balanceOf(alice)).toBe(1000);
  });

  it("a replayed request does not write a second event", async () => {
    const alice = await userWithBalance(1000);
    const bob = await userWithBalance(0);
    const key = randomUUID();
    const first = (await postTransfer(key, usd(alice, bob, 100))).json();
    await Promise.all(Array.from({ length: 10 }, () => postTransfer(key, usd(alice, bob, 100))));
    expect(await eventsFor(first.id)).toHaveLength(1);
  });

  it("an outbox event can only be written inside a transaction that also commits the change", async () => {
    // The API makes the mistake hard: enqueueOutboxEvent takes a transaction client, not the pool.
    const id = await withTransaction(pool, (c) =>
      enqueueOutboxEvent(c, { eventType: "test.event", aggregateType: "transfer", aggregateId: randomUUID(), payload: {} }),
    );
    expect((await row(id)).status).toBe("pending");
  });
});

describe("the outbox worker", () => {
  it("publishes a pending event once and marks it published", async () => {
    const [id] = await enqueue();
    const w = worker();
    expect(await w.drain()).toMatchObject({ claimed: 1, published: 1 });
    expect(await w.drain()).toMatchObject({ claimed: 0 });
    expect(dest.deliveriesOf(id)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "published", attempts: 1, claim_token: null });
  });

  it("publishes events created by real transfers, end to end", async () => {
    const alice = await userWithBalance(1000);
    const bob = await userWithBalance(0);
    const t = (await postTransfer(randomUUID(), usd(alice, bob, 250))).json();
    await worker().drain();
    const [event] = await eventsFor(t.id);
    expect(dest.applied.has(event.event_id)).toBe(true);
  });

  it("runs in the background and stops cleanly", async () => {
    const w = worker({ pollIntervalMs: 20 });
    w.start();
    const [id] = await enqueue();
    for (let i = 0; i < 100 && (await row(id)).status !== "published"; i++) await sleep(20);
    await w.stop();
    expect(await row(id)).toMatchObject({ status: "published" });
  });
});

describe("worker crashes", () => {
  it("crash after claiming, before publishing: the lease expires and another worker publishes it", async () => {
    const [id] = await enqueue();
    const a = worker({ leaseMs: 300, publishTimeoutMs: 100 });
    const b = worker({ leaseMs: 300, publishTimeoutMs: 100 });

    const claim = await a.claim(); // ...and worker A dies here.
    expect(claim.events.map((e) => e.event_id)).toEqual([id]);

    expect((await b.runOnce()).claimed).toBe(0); // still leased to A: B must not touch it
    await sleep(350);
    expect(await b.runOnce()).toMatchObject({ claimed: 1, published: 1 });

    expect(dest.deliveriesOf(id)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "published", attempts: 2 });
  });

  it("crash after publishing, before recording it: the event is delivered again, and the consumer applies it once", async () => {
    // The outbox's version of "the database committed but the response was
    // lost". The destination accepted the event, but the worker never got to
    // write `published`. From the worker's side that is indistinguishable from
    // a failed publish, so it must publish again: at-least-once.
    const [id] = await enqueue();
    const a = worker({ leaseMs: 300, publishTimeoutMs: 100 });
    const b = worker({ leaseMs: 300, publishTimeoutMs: 100 });

    const claim = await a.claim();
    await dest.publish(claim.events[0], new AbortController().signal); // delivered...
    // ...and worker A dies before markPublished.

    await sleep(350);
    await b.drain();

    expect(dest.deliveriesOf(id)).toHaveLength(2); // delivered twice, with the same event id
    expect(dest.applied.size).toBe(1); // applied once
    expect(await row(id)).toMatchObject({ status: "published", attempts: 2 });
  });

  it("a worker that stalls past its lease cannot overwrite the worker that took over (fencing)", async () => {
    const [id] = await enqueue();
    const slow = worker({ leaseMs: 300, publishTimeoutMs: 100 });
    const fast = worker({ leaseMs: 300, publishTimeoutMs: 100 });

    const stale = await slow.claim(); // e.g. a long GC pause starts here
    await sleep(350);
    const current = await fast.claim(); // the lease ran out, so fast takes over, and is mid-publish

    // The slow worker wakes up and reports on a row it no longer owns. Without
    // the claim_token check, its "failed" would reschedule the row under fast's
    // feet, and its "published" would mark it done before fast had delivered it.
    expect(await slow.markFailed(stale, stale.events[0], new Error("late"))).toBe("lost_lease");
    expect(await slow.markPublished(stale, stale.events[0])).toBe(false);
    expect(await row(id)).toMatchObject({ status: "pending", claim_token: current.token, last_error: null });

    expect(await fast.markPublished(current, current.events[0])).toBe(true);
    expect(await row(id)).toMatchObject({ status: "published", attempts: 2, last_error: null });
  });

  it("a crash on the final attempt retires the event as dead rather than trying beyond maxAttempts", async () => {
    const [id] = await enqueue();
    const w = worker({ leaseMs: 200, publishTimeoutMs: 100, maxAttempts: 1 });
    await w.claim(); // attempt 1 of 1, then the worker dies
    await sleep(250);
    expect((await w.runOnce()).claimed).toBe(0);
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 1 });
    expect((await row(id)).last_error).toMatch(/lease expired on the final attempt/);
    expect(dest.deliveries).toHaveLength(0);
  });

  it("a publish that hangs is timed out and retried, without waiting for the lease", async () => {
    const [id] = await enqueue();
    let calls = 0;
    dest.behaviour = (_e, signal) => {
      if (++calls === 1) return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const w = worker({ publishTimeoutMs: 50, baseDelayMs: 1 });
    expect(await w.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    expect((await row(id)).last_error).toMatch(/timed out/);
    await sleep(5);
    expect(await w.drain()).toMatchObject({ published: 1 });
    expect(dest.deliveriesOf(id)).toHaveLength(1);
  });
});

describe("concurrent workers", () => {
  it("6 workers draining 300 events at once deliver each event exactly once", async () => {
    const ids = await enqueue(300);
    dest.behaviour = () => sleep(Math.random() * 3);
    const workers = Array.from({ length: 6 }, (_, i) => worker({ workerId: `w${i}`, batchSize: 7 }));
    const results = await Promise.all(workers.map((w) => w.drain()));

    expect(results.reduce((n, r) => n + r.published, 0)).toBe(300);
    expect(results.filter((r) => r.published > 0).length).toBeGreaterThan(1); // the work really was shared
    expect(dest.deliveries).toHaveLength(300); // no event published twice
    expect(new Set(dest.deliveries.map((d) => d.eventId))).toEqual(new Set(ids));
    const { rows } = await pool.query("SELECT status, count(*)::int AS n FROM outbox WHERE event_id = ANY($1) GROUP BY status", [ids]);
    expect(rows).toEqual([{ status: "published", n: 300 }]);
  });

  it("with a flaky destination (30% of calls fail), every event is still accepted exactly once", async () => {
    const ids = await enqueue(120);
    dest.behaviour = () => {
      if (Math.random() < 0.3) throw new Error("503 Service Unavailable");
    };
    const workers = Array.from({ length: 4 }, () => worker({ batchSize: 5, baseDelayMs: 2, maxDelayMs: 20, maxAttempts: 50 }));
    for (let round = 0; round < 50; round++) {
      await Promise.all(workers.map((w) => w.drain()));
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE event_id = ANY($1) AND status = 'pending'", [ids]);
      if (rows[0].n === 0) break;
      await sleep(25); // let backoff timers come due
    }
    expect(dest.deliveries).toHaveLength(120);
    expect(dest.applied.size).toBe(120);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE event_id = ANY($1) AND status = 'published'", [ids]);
    expect(rows[0].n).toBe(120);
  });
});

describe("retries and exhaustion", () => {
  it("retries with growing delays, then marks the event dead after maxAttempts", async () => {
    const [id] = await enqueue();
    const attempts: number[] = [];
    dest.behaviour = () => {
      attempts.push(Date.now());
      throw new Error("connection refused");
    };
    // random = 0 makes the jitter deterministic: delays are exactly half of
    // each window, i.e. 20, 40, 80 ms for a base of 40 ms.
    const w = worker({ maxAttempts: 4, baseDelayMs: 40, random: () => 0 });
    while ((await row(id)).status === "pending") {
      await w.runOnce();
      await sleep(5);
    }

    expect(attempts).toHaveLength(4);
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(20 - 2);
    expect(gaps[1]).toBeGreaterThanOrEqual(40 - 2);
    expect(gaps[2]).toBeGreaterThanOrEqual(80 - 2);
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 4, last_error: "attempt 4: connection refused" });

    // Dead events stay put: no more attempts.
    await sleep(100);
    expect((await w.runOnce()).claimed).toBe(0);
    expect(attempts).toHaveLength(4);
  });

  it("a permanent error goes straight to dead, and an operator can requeue it", async () => {
    const [id] = await enqueue();
    dest.behaviour = () => {
      throw new PermanentPublishError("HTTP 400: schema rejected");
    };
    const w = worker({ maxAttempts: 10 });
    expect(await w.runOnce()).toMatchObject({ dead: 1 });
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 1 });

    dest.behaviour = () => {}; // the destination is fixed
    expect(await requeueDeadEvent(pool, id)).toBe(true);
    expect(await w.drain()).toMatchObject({ published: 1 });
    expect(await row(id)).toMatchObject({ status: "published" });
    expect(await requeueDeadEvent(pool, id)).toBe(false); // only dead events can be requeued
  });

  it("backoff doubles per attempt, is capped, and is jittered within [window/2, window]", () => {
    const cfg = { baseDelayMs: 1000, maxDelayMs: 60_000 };
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, cfg, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, cfg, () => 0))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelayMs(30, cfg, () => 1)).toBe(60_000);
    expect(backoffDelayMs(30, cfg, () => 0)).toBe(30_000);
  });

  it("refuses a publish timeout that is not shorter than the lease", () => {
    expect(() => new OutboxWorker(pool, dest, { leaseMs: 1000, publishTimeoutMs: 1000 })).toThrow(/shorter than leaseMs/);
  });
});

describe("httpPublisher", () => {
  const event: OutboxEvent = {
    id: 1,
    event_id: randomUUID(),
    event_type: "transfer.posted",
    aggregate_type: "transfer",
    aggregate_id: randomUUID(),
    payload: { amount_cents: 100 },
    attempts: 1,
    created_at: new Date(),
  };
  const respond = (status: number) => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { calls, publisher: httpPublisher("https://example.test/hooks", fetchImpl) };
  };
  const signal = new AbortController().signal;

  it("sends the event id as the Idempotency-Key and succeeds on 2xx", async () => {
    const { calls, publisher } = respond(204);
    await publisher.publish(event, signal);
    expect((calls[0].headers as Record<string, string>)["idempotency-key"]).toBe(event.event_id);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ id: event.event_id, type: "transfer.posted" });
  });

  it.each([500, 503, 408, 429])("treats HTTP %i as retryable", async (status) => {
    const err = await respond(status).publisher.publish(event, signal).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentPublishError);
  });

  it.each([400, 404, 422])("treats HTTP %i as permanent", async (status) => {
    await expect(respond(status).publisher.publish(event, signal)).rejects.toBeInstanceOf(PermanentPublishError);
  });
});
