// "What if the database commits but the API response is lost?"
//
// Two ways that happens, both tested against a real HTTP server and a real
// Postgres:
//
//  1. The transaction committed and the server built a 201, but the
//     connection dropped before the client read it (a proxy timeout, a phone
//     going into a tunnel). The client sees a network error.
//  2. COMMIT reached Postgres and succeeded, but the acknowledgement never
//     reached the server, so the server itself does not know the outcome and
//     answers 500. The client sees a server error.
//
// In both, the client cannot tell whether money moved. The answer is the same:
// retry with the same Idempotency-Key. The retry returns the original transfer,
// money moves once, and exactly one outbox event announces it, whether or not
// the client ever retries.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { checkLedgerInvariants } from "../src/ledger/accounts.js";
import { OutboxWorker, type Publisher } from "../src/outbox/worker.js";
import { app, AS_OPERATOR, balanceOf, operatorAuth, pool, usd, userWithBalance } from "./helpers.js";

afterEach(async () => {
  expect(await checkLedgerInvariants(pool)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function transfersWithKey(key: string) {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM transfers WHERE idempotency_key = $1", [key]);
  return rows;
}

async function outboxEventsFor(transferId: string) {
  const { rows } = await pool.query<{ event_id: string; event_type: string; status: string }>(
    "SELECT event_id, event_type, status FROM outbox WHERE aggregate_id = $1",
    [transferId],
  );
  return rows;
}

/** Retry the way a careful client does: same key, same body. */
function send(baseUrl: string, key: string, body: object) {
  return fetch(`${baseUrl}/transfers`, {
    method: "POST",
    headers: { ...AS_OPERATOR, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

describe("the database commits but the API response is lost", () => {
  it("the connection drops after commit: the retry returns the original transfer, and money moves once", async () => {
    let dropNextResponse = true;
    const server = buildApp(pool, operatorAuth);
    // Runs after the handler (so after COMMIT), just before bytes go out.
    server.addHook("onSend", async (req, _reply, payload) => {
      if (req.url === "/transfers" && dropNextResponse) {
        dropNextResponse = false;
        req.raw.socket.destroy();
      }
      return payload;
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    try {
      const alice = await userWithBalance(5000);
      const bob = await userWithBalance(0);
      const key = randomUUID();
      const body = usd(alice, bob, 1200);

      // The client never gets an answer.
      await expect(send(baseUrl, key, body)).rejects.toThrow();
      // But the money did move. The client can't know that, which is the problem.
      expect(await balanceOf(alice)).toBe(3800);

      const retry = await send(baseUrl, key, body);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      const transfer = await retry.json();

      const rows = await transfersWithKey(key);
      expect(rows).toEqual([{ id: transfer.id }]);
      expect(await balanceOf(alice)).toBe(3800);
      expect(await balanceOf(bob)).toBe(1200);
      expect((await outboxEventsFor(transfer.id)).map((e) => e.event_type)).toEqual(["transfer.posted"]);
    } finally {
      await server.close();
    }
  });

  it("COMMIT succeeds but its acknowledgement is lost: the server answers 500, and the retry finds the committed transfer", async () => {
    // A pool whose connections run COMMIT for real and then report the
    // connection as broken, as if the network died while the reply was in flight.
    const lossyPool = {
      connect: async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== "query") return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              const result = await realQuery(...args);
              if (args[0] === "COMMIT") throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
              return result;
            };
          },
        });
      },
      query: pool.query.bind(pool),
    } as unknown as pg.Pool;

    const lossy = buildApp(lossyPool, operatorAuth);
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const key = randomUUID();
    const body = usd(alice, bob, 700);

    const first = await lossy.inject({ method: "POST", url: "/transfers", headers: { ...AS_OPERATOR, "idempotency-key": key }, payload: body });
    expect(first.statusCode).toBe(500); // the server honestly does not know the outcome
    expect(await balanceOf(alice)).toBe(4300); // it did commit

    // The retry lands on a healthy instance (here: the normal app).
    const retry = await app.inject({ method: "POST", url: "/transfers", headers: { ...AS_OPERATOR, "idempotency-key": key }, payload: body });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await transfersWithKey(key)).toHaveLength(1);
    expect(await balanceOf(alice)).toBe(4300);
    expect(await outboxEventsFor(retry.json().id)).toHaveLength(1);
    await lossy.close();
  });

  it("even if the client never retries, downstream still hears about the transfer exactly once", async () => {
    const alice = await userWithBalance(5000);
    const bob = await userWithBalance(0);
    const key = randomUUID();
    const res = await app.inject({ method: "POST", url: "/transfers", headers: { ...AS_OPERATOR, "idempotency-key": key }, payload: usd(alice, bob, 300) });
    // Pretend this response was lost and the client went away for good.
    const transferId = res.json().id;

    const received: string[] = [];
    const publisher: Publisher = {
      async publish(e) {
        if (e.aggregate_id === transferId) received.push(e.event_type);
      },
    };
    await new OutboxWorker(pool, publisher).drain();
    expect(received).toEqual(["transfer.posted"]);
    expect((await outboxEventsFor(transferId)).map((e) => e.status)).toEqual(["published"]);
  });
});
