import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { createAccount, getAccount, listEntries } from "./ledger/accounts.js";
import { createTransfer, getTransfer, type Transfer } from "./ledger/transfers.js";
import { createDeposit, getDeposit, handleStripeEvent, type Deposit } from "./payments/deposits.js";
import { verifyStripeEvent, type PaymentsConfig } from "./payments/stripe.js";
import type { BankWebhookEvent } from "./bank/mockBank.js";
import { BANK_SIGNATURE_HEADER, verifyBankWebhook } from "./bank/signature.js";
import { createPayout, getPayout, handleBankWebhook, type Payout } from "./payouts/payouts.js";

const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD");

const transferBody = z.object({
  from_account_id: uuid,
  to_account_id: uuid,
  // Integer cents only. Floats like 10.1 are rejected rather than rounded.
  amount_cents: z.number().int().positive().max(100_000_000_00),
  currency,
});

// Stripe Checkout caps a single payment at $999,999.99.
const depositBody = z.object({
  account_id: uuid,
  amount_cents: z.number().int().positive().max(99_999_999),
  currency,
});

const payoutBody = z.object({
  account_id: uuid,
  amount_cents: z.number().int().positive().max(100_000_000_00),
  currency,
  // Digits only. The mock bank decides the outcome from the last four (see src/bank/mockBank.ts).
  bank_account_number: z.string().regex(/^\d{4,17}$/, "4-17 digits"),
});

const accountBody = z.object({ name: z.string().min(1).max(200), currency });

// Keys are client-generated (a UUID v4 is ideal). Bounded so they can't be used to bloat the index.
const idempotencyKey = z.string().min(8).max(255);

function serializeTransfer(t: Transfer) {
  return { ...t, created_at: t.created_at.toISOString() };
}

function serializeDeposit(d: Deposit) {
  return { ...d, created_at: d.created_at.toISOString(), updated_at: d.updated_at.toISOString() };
}

function serializePayout(p: Payout) {
  return { ...p, created_at: p.created_at.toISOString(), updated_at: p.updated_at.toISOString() };
}

function requireIdempotencyKey(header: unknown): string {
  const parsed = idempotencyKey.safeParse(header);
  if (!parsed.success) {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-255 chars).");
  }
  return parsed.data;
}

export function buildApp(
  pool: pg.Pool,
  opts: {
    logger?: boolean;
    payments?: PaymentsConfig;
    /** Shared secret for bank webhook signatures. Unset: POST /webhooks/bank returns 503. */
    bankWebhookSecret?: string;
  } = {},
): FastifyInstance {
  const payments: PaymentsConfig = opts.payments ?? { appBaseUrl: "http://localhost:3000" };
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
    const key = requireIdempotencyKey(req.headers["idempotency-key"]);
    const body = transferBody.parse(req.body);
    const { transfer, replayed } = await createTransfer(pool, key, body, { scope: "api" });

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

  // ---- Deposits (Stripe Checkout, test mode) --------------------------------

  app.post("/deposits", async (req, reply) => {
    if (!payments.gateway) {
      throw new ApiError(503, "payments_not_configured", "Set STRIPE_SECRET_KEY (a test-mode key) to enable deposits.");
    }
    const key = requireIdempotencyKey(req.headers["idempotency-key"]);
    const body = depositBody.parse(req.body);
    const { deposit, replayed } = await createDeposit(pool, payments.gateway, key, body, payments.appBaseUrl);
    if (replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(201).send(serializeDeposit(deposit));
  });

  // Also the Checkout success/cancel URL. Landing here credits nothing: the
  // status only changes when the verified webhook arrives, so a client should
  // show "pending" until it does.
  app.get("/deposits/:id", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const deposit = await getDeposit(pool, id);
    if (!deposit) throw new ApiError(404, "deposit_not_found", "Deposit not found.");
    return serializeDeposit(deposit);
  });

  // ---- Payouts (mock bank) ----------------------------------------------------

  // Holds the money and queues the payout for the bank, in one transaction.
  // No bank call happens here: the outbox worker sends it after commit.
  app.post("/payouts", async (req, reply) => {
    const key = requireIdempotencyKey(req.headers["idempotency-key"]);
    const body = payoutBody.parse(req.body);
    const { payout, replayed } = await createPayout(pool, key, body);
    if (replayed) reply.header("Idempotent-Replayed", "true");
    if (payout.status === "rejected") {
      return reply.status(422).send({
        error: { code: payout.failure_reason, message: "Payout rejected." },
        payout: serializePayout(payout),
      });
    }
    return reply.status(201).send(serializePayout(payout));
  });

  app.get("/payouts/:id", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const payout = await getPayout(pool, id);
    if (!payout) throw new ApiError(404, "payout_not_found", "Payout not found.");
    return serializePayout(payout);
  });

  // Signature verification needs the exact bytes Stripe signed, so this route
  // lives in its own scope where JSON bodies are kept as a raw Buffer.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/stripe", async (req, reply) => {
      if (!payments.webhookSecret) {
        throw new ApiError(503, "payments_not_configured", "Set STRIPE_WEBHOOK_SECRET to accept Stripe webhooks.");
      }
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
        throw new ApiError(400, "invalid_signature", "Missing Stripe-Signature header or JSON body.");
      }
      let event;
      try {
        event = verifyStripeEvent(req.body, signature, payments.webhookSecret);
      } catch {
        // Nothing is recorded for an unverified request.
        throw new ApiError(400, "invalid_signature", "Webhook signature verification failed.");
      }
      if (event.livemode) {
        throw new ApiError(400, "livemode_not_allowed", "Only Stripe test-mode events are accepted.");
      }
      // A thrown error becomes a 500, so Stripe retries. Because processing is
      // one transaction, a failed attempt leaves nothing behind.
      const result = await handleStripeEvent(pool, event);
      return reply.status(200).send({ received: true, ...result });
    });

    // Same contract as the Stripe webhook: 400 if the signature is bad
    // (nothing recorded), 200 once processed or a duplicate, 500 on an error
    // so the bank redelivers.
    scope.post("/webhooks/bank", async (req, reply) => {
      if (!opts.bankWebhookSecret) {
        throw new ApiError(503, "payouts_not_configured", "Set BANK_WEBHOOK_SECRET to accept bank webhooks.");
      }
      const signature = req.headers[BANK_SIGNATURE_HEADER];
      if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
        throw new ApiError(400, "invalid_signature", "Missing Bank-Signature header or JSON body.");
      }
      let event: BankWebhookEvent;
      try {
        verifyBankWebhook(req.body, signature, opts.bankWebhookSecret);
        event = JSON.parse(req.body.toString("utf8"));
      } catch {
        throw new ApiError(400, "invalid_signature", "Webhook signature verification failed.");
      }
      if (typeof event?.id !== "string" || typeof event.type !== "string") {
        throw new ApiError(400, "invalid_event", "Webhook body is not a bank event.");
      }
      const result = await handleBankWebhook(pool, event);
      return reply.status(200).send({ received: true, ...result });
    });
  });

  return app;
}
