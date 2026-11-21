import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { createAccount, getAccount, listEntries } from "./ledger/accounts.js";
import { createTransfer, getTransfer, type Transfer } from "./ledger/transfers.js";

const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD");

const transferBody = z.object({
  from_account_id: uuid,
  to_account_id: uuid,
  // Integer cents only. Floats like 10.1 are rejected rather than rounded.
  amount_cents: z.number().int().positive().max(100_000_000_00),
  currency,
});

const accountBody = z.object({ name: z.string().min(1).max(200), currency });

// Keys are client-generated (a UUID v4 is ideal). Bounded so they can't be used to bloat the index.
const idempotencyKey = z.string().min(8).max(255);

function serializeTransfer(t: Transfer) {
  return { ...t, created_at: t.created_at.toISOString() };
}

export function buildApp(pool: pg.Pool, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: "invalid_request", message: "Invalid request", details: err.issues } });
    }
    const fastifyErr = err as { statusCode?: number; message: string };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({ error: { code: "invalid_request", message: fastifyErr.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: "internal_error", message: "Internal error" } });
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  app.post("/accounts", async (req, reply) => {
    const body = accountBody.parse(req.body);
    return reply.status(201).send(await createAccount(pool, body));
  });

  app.get("/accounts/:id", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const account = await getAccount(pool, id);
    if (!account) throw new ApiError(404, "account_not_found", "Account not found.");
    return account;
  });

  app.get("/accounts/:id/entries", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.coerce.number().int().optional() })
      .parse(req.query);
    if (!(await getAccount(pool, id))) throw new ApiError(404, "account_not_found", "Account not found.");
    return { data: await listEntries(pool, id, q) };
  });

  app.post("/transfers", async (req, reply) => {
    const keyHeader = req.headers["idempotency-key"];
    const parsedKey = idempotencyKey.safeParse(keyHeader);
    if (!parsedKey.success) {
      throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-255 chars).");
    }
    const body = transferBody.parse(req.body);
    const { transfer, replayed } = await createTransfer(pool, parsedKey.data, body);

    if (replayed) reply.header("Idempotent-Replayed", "true");
    if (transfer.status === "rejected") {
      return reply.status(422).send({
        error: { code: transfer.failure_reason, message: "Transfer rejected." },
        transfer: serializeTransfer(transfer),
      });
    }
    // Same status code for the original and the replay, so a client that
    // retries after a lost response sees exactly what it would have seen.
    return reply.status(201).send(serializeTransfer(transfer));
  });

  app.get("/transfers/:id", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const transfer = await getTransfer(pool, id);
    if (!transfer) throw new ApiError(404, "transfer_not_found", "Transfer not found.");
    return serializeTransfer(transfer);
  });

  return app;
}
