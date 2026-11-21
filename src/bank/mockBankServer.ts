import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { BankConflictError, BankRejectedError, BankUnavailableError } from "./client.js";
import { MockBank, type BankWebhookEvent } from "./mockBank.js";
import { signBankWebhook, BANK_SIGNATURE_HEADER } from "./signature.js";

/** POSTs each webhook event to `url`, signed. A non-2xx answer counts as not delivered, so the bank retries it. */
export function httpWebhookDeliverer(url: string, secret: string, fetchImpl: typeof fetch = fetch) {
  return async (event: BankWebhookEvent) => {
    const body = JSON.stringify(event);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", [BANK_SIGNATURE_HEADER]: signBankWebhook(secret, body) },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`webhook receiver answered HTTP ${res.status}`);
  };
}

const payoutBody = z.object({
  reference: z.string().min(1),
  amount_cents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  account_number: z.string().regex(/^\d{4,17}$/),
});

const listQuery = z.object({
  idempotency_key: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  starting_after: z.string().min(1).optional(),
});

const tamperBody = z.object({
  idempotency_key: z.string().min(1),
  status: z.enum(["processing", "succeeded", "failed", "returned"]).optional(),
  amount_cents: z.number().int().positive().optional(),
});

const behaviourBody = z
  .object({
    outage: z.boolean(),
    loseResponses: z.number().int().min(0),
    latencyMs: z.number().int().min(0),
    settleAfterMs: z.number().int().min(0),
    returnAfterMs: z.number().int().min(0),
    webhookCopies: z.number().int().min(1).max(10),
    webhooksEnabled: z.boolean(),
  })
  .partial();

/**
 * The mock bank over HTTP, so the platform can talk to it exactly as it would
 * to a real provider. `/_admin/*` is the chaos panel for demos.
 */
export function buildMockBankServer(bank: MockBank): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post("/payouts", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.status(400).send({ error: { code: "idempotency_key_required" } });
    }
    const body = payoutBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: { code: "invalid_request" } });
    try {
      const replay = bank.knows(key);
      const payout = await bank.createPayout({ idempotency_key: key, ...body.data });
      return reply.status(replay ? 200 : 201).send(payout);
    } catch (err) {
      if (err instanceof BankUnavailableError) {
        // A lost response is simulated by never answering in time: close the socket.
        if (err.message.startsWith("timed out")) {
          reply.hijack();
          req.raw.socket.destroy();
          return reply;
        }
        return reply.status(503).send({ error: { code: "bank_unavailable" } });
      }
      if (err instanceof BankRejectedError) return reply.status(422).send({ error: { code: err.code }, payout: err.payout });
      if (err instanceof BankConflictError) return reply.status(409).send({ error: { code: "idempotency_key_reused" } });
      throw err;
    }
  });

  // With ?idempotency_key=: one payout (404 if unknown). Without: the
  // statement, paginated with ?limit= and ?starting_after=<bank payout id>.
  app.get("/payouts", async (req, reply) => {
    const q = listQuery.parse(req.query);
    const key = q.idempotency_key;
    try {
      if (!key) return await bank.listPayouts({ limit: q.limit, starting_after: q.starting_after });
      const payout = await bank.getPayoutByKey(key);
      return payout ? payout : reply.status(404).send({ error: { code: "not_found" } });
    } catch (err) {
      if (err instanceof BankUnavailableError) return reply.status(503).send({ error: { code: "bank_unavailable" } });
      throw err;
    }
  });

  app.get("/_admin/state", async () => ({
    behaviour: bank.behaviour,
    payouts: bank.payouts(),
    pending_webhooks: bank.pendingWebhooks(),
    deliveries: bank.deliveryLog.slice(-50),
  }));

  app.post("/_admin/behaviour", async (req) => {
    Object.assign(bank.behaviour, behaviourBody.parse(req.body));
    return bank.behaviour;
  });

  // Make the bank change its story about a payout, for reconciliation demos.
  app.post("/_admin/tamper", async (req, reply) => {
    const body = tamperBody.parse(req.body);
    const { idempotency_key, ...change } = body;
    if (!bank.knows(idempotency_key)) return reply.status(404).send({ error: { code: "not_found" } });
    bank.tamper(idempotency_key, change);
    return bank.getPayoutByKey(idempotency_key);
  });

  app.post("/_admin/process", async () => {
    await bank.processDue();
    return { ok: true };
  });

  return app;
}
