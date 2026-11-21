import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { createTransfer } from "../ledger/transfers.js";
import { createDeposit, getDeposit } from "../payments/deposits.js";
import type { PaymentsConfig } from "../payments/stripe.js";
import { createPayout } from "../payouts/payouts.js";
import { getActivityItem, getBalances, isValidCursor, listActivity, listStatement, type ActivityItem } from "./activity.js";
import { issueSessionToken, verifySessionToken } from "./auth.js";
import {
  DEMO_CHECKOUT_OUTCOMES,
  DEMO_SESSION_PREFIX,
  demoCheckoutEvents,
  signStripePayload,
  type DemoCheckoutOutcome,
} from "./demoCheckout.js";

export interface WalletOptions {
  /** Signs demo session tokens. Unset: every /me route answers 503. */
  sessionSecret?: string;
  /** Deposits go through the demo checkout page instead of Stripe (see demoCheckout.ts). */
  demoCheckout?: boolean;
  /** The mock bank's base URL, to expose its chaos switches to the wallet's demo panel. */
  demoBankUrl?: string;
}

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(200);
const amount = z.number().int().positive().max(100_000_000_00);

const transferBody = z.object({ to_account_id: uuid, amount_cents: amount });
// Stripe Checkout caps a single payment at $999,999.99.
const depositBody = z.object({ amount_cents: z.number().int().positive().max(99_999_999) });
const payoutBody = z.object({ amount_cents: amount, bank_account_number: z.string().regex(/^\d{4,17}$/, "4-17 digits") });
const demoCheckoutBody = z.object({ outcome: z.enum(DEMO_CHECKOUT_OUTCOMES) });
// Only the switches that make sense from a user's screen.
const bankBehaviourBody = z
  .object({
    outage: z.boolean(),
    loseResponses: z.number().int().min(0).max(10),
    webhookCopies: z.number().int().min(1).max(5),
    webhooksEnabled: z.boolean(),
  })
  .partial();

interface SessionAccount {
  id: string;
  name: string;
  currency: string;
}

const sessions = new WeakMap<FastifyRequest, SessionAccount>();
const me = (req: FastifyRequest) => sessions.get(req)!;

/**
 * Keys are chosen by the browser, so they are namespaced by account: two
 * users who happen to send the same key get two separate operations, and a
 * user cannot replay (or block) someone else's request by guessing its key.
 */
function scopedKey(req: FastifyRequest): string {
  const parsed = idempotencyKey.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success) {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-200 chars).");
  }
  return `wallet:${me(req).id}:${parsed.data}`;
}

function send(reply: FastifyReply, replayed: boolean, item: ActivityItem | undefined, error?: { code: string; message: string }) {
  if (!item) throw new Error("operation committed but is missing from the feed");
  if (replayed) reply.header("Idempotent-Replayed", "true");
  // Same status for the original and the replay, like the rest of the API.
  return error ? reply.status(422).send({ error, item, replayed }) : reply.status(201).send({ item, replayed });
}

/**
 * The user-facing API behind the wallet at /wallet/. Everything acts on the
 * signed-in user's own account: no route takes an account id to act on, so
 * there is nothing to tamper with. Money moves through exactly the same
 * functions as the rest of the API (createTransfer, createDeposit, createPayout).
 */
export function registerWalletRoutes(app: FastifyInstance, pool: pg.Pool, payments: PaymentsConfig, opts: WalletOptions) {
  const depositsMode = opts.demoCheckout ? "demo_checkout" : payments.gateway ? "stripe_test" : "disabled";

  app.register(
    async (wallet) => {
      wallet.addHook("onRequest", async () => {
        if (!opts.sessionSecret) {
          throw new ApiError(503, "wallet_not_configured", "Set WALLET_SESSION_SECRET to enable the wallet.");
        }
      });

      wallet.get("/config", async () => ({
        sign_in: "demo",
        deposits: depositsMode,
        bank_controls: Boolean(opts.demoBankUrl),
      }));

      // The demo sign-in screen: every user account, so you can pick one.
      wallet.get("/demo-users", async () => {
        const { rows } = await pool.query(
          `SELECT id, name, currency, balance_cents FROM accounts WHERE kind = 'user' ORDER BY created_at, id LIMIT 100`,
        );
        return { data: rows };
      });

      wallet.post("/session", async (req, reply) => {
        const { account_id } = z.object({ account_id: uuid }).parse(req.body);
        const balances = await getBalances(pool, account_id);
        if (!balances) throw new ApiError(404, "account_not_found", "No user account with this id.");
        return reply.status(201).send({ ...issueSessionToken(opts.sessionSecret!, account_id), account: balances.account });
      });

      wallet.register(async (authed) => {
        authed.addHook("onRequest", async (req) => {
          const header = req.headers.authorization ?? "";
          const accountId = header.startsWith("Bearer ") ? verifySessionToken(opts.sessionSecret!, header.slice(7)) : null;
          const balances = accountId && uuid.safeParse(accountId).success ? await getBalances(pool, accountId) : undefined;
          if (!balances) throw new ApiError(401, "unauthorized", "Sign in again.");
          sessions.set(req, balances.account);
        });

        authed.get("/", async (req) => getBalances(pool, me(req).id));

        authed.get("/activity", async (req) => {
          const q = z
            .object({
              limit: z.coerce.number().int().min(1).max(200).optional(),
              before: z.string().refine(isValidCursor, "a next_cursor value").optional(),
            })
            .parse(req.query);
          return listActivity(pool, me(req).id, q);
        });

        authed.get("/statement", async (req) => {
          const q = z
            .object({ limit: z.coerce.number().int().min(1).max(500).optional(), before: z.coerce.number().int().optional() })
            .parse(req.query);
          return listStatement(pool, me(req).id, q);
        });

        // Who you can send money to: the other users in your currency (a demo directory).
        authed.get("/payees", async (req) => {
          const { rows } = await pool.query(
            `SELECT id, name FROM accounts WHERE kind = 'user' AND currency = $1 AND id <> $2 ORDER BY name, id LIMIT 100`,
            [me(req).currency, me(req).id],
          );
          return { data: rows };
        });

        authed.post("/transfers", async (req, reply) => {
          const key = scopedKey(req);
          const body = transferBody.parse(req.body);
          const { id, currency } = me(req);
          const { transfer, replayed } = await createTransfer(
            pool,
            key,
            { from_account_id: id, to_account_id: body.to_account_id, amount_cents: body.amount_cents, currency },
            { scope: "api" },
          );
          const item = await getActivityItem(pool, id, "transfer_out", transfer.id);
          const error =
            transfer.status === "rejected"
              ? { code: transfer.failure_reason ?? "rejected", message: "Not enough money for this transfer." }
              : undefined;
          return send(reply, replayed, item, error);
        });

        authed.post("/deposits", async (req, reply) => {
          if (!payments.gateway) {
            throw new ApiError(503, "payments_not_configured", "Deposits are off: set STRIPE_SECRET_KEY, or DEMO_MODE=true.");
          }
          const key = scopedKey(req);
          const body = depositBody.parse(req.body);
          const { id, currency } = me(req);
          const { deposit, replayed } = await createDeposit(
            pool,
            payments.gateway,
            key,
            { account_id: id, amount_cents: body.amount_cents, currency },
            payments.appBaseUrl,
            `${payments.appBaseUrl}/wallet/`,
          );
          if (replayed) reply.header("Idempotent-Replayed", "true");
          const item = await getActivityItem(pool, id, "deposit", deposit.id);
          return reply.status(201).send({ item, replayed, checkout_url: deposit.checkout_url });
        });

        authed.get("/deposits/:id", async (req) => {
          const depositId = uuid.parse((req.params as { id: string }).id);
          const item = await getActivityItem(pool, me(req).id, "deposit", depositId);
          if (!item) throw new ApiError(404, "deposit_not_found", "Deposit not found.");
          return item;
        });

        authed.post("/payouts", async (req, reply) => {
          const key = scopedKey(req);
          const body = payoutBody.parse(req.body);
          const { id, currency } = me(req);
          const { payout, replayed } = await createPayout(pool, key, { account_id: id, currency, ...body });
          const item = await getActivityItem(pool, id, "payout", payout.id);
          const error =
            payout.status === "rejected"
              ? { code: payout.failure_reason ?? "rejected", message: "Not enough money for this withdrawal." }
              : undefined;
          return send(reply, replayed, item, error);
        });

        if (opts.demoCheckout) {
          // The demo checkout page's "pay" buttons. Stands in for Stripe sending
          // its webhook: the events go through POST /webhooks/stripe, signature
          // check included. Only the deposit's owner can complete it.
          authed.post("/deposits/:id/demo-checkout", async (req) => {
            const depositId = uuid.parse((req.params as { id: string }).id);
            const { outcome } = demoCheckoutBody.parse(req.body);
            const deposit = await getDeposit(pool, depositId);
            if (!deposit || deposit.account_id !== me(req).id) throw new ApiError(404, "deposit_not_found", "Deposit not found.");
            if (!deposit.stripe_checkout_session_id?.startsWith(DEMO_SESSION_PREFIX)) {
              throw new ApiError(409, "not_a_demo_checkout", "This deposit was not opened with the demo checkout.");
            }
            const deliveries = [];
            for (const event of demoCheckoutEvents(outcome as DemoCheckoutOutcome, deposit)) {
              const payload = JSON.stringify(event);
              const res = await app.inject({
                method: "POST",
                url: "/webhooks/stripe",
                headers: { "content-type": "application/json", "stripe-signature": signStripePayload(payload, payments.webhookSecret!) },
                payload,
              });
              deliveries.push({ status: res.statusCode, ...(res.json() as object) });
            }
            return { deliveries, item: await getActivityItem(pool, me(req).id, "deposit", depositId) };
          });
        }

        if (opts.demoBankUrl) {
          const bankUrl = opts.demoBankUrl.replace(/\/$/, "");
          const callBank = async (method: "GET" | "POST", path: string, body?: unknown) => {
            try {
              const res = await fetch(`${bankUrl}${path}`, {
                method,
                headers: body === undefined ? {} : { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(5_000),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return (await res.json()) as Record<string, unknown>;
            } catch (err) {
              throw new ApiError(502, "bank_unreachable", `The mock bank did not answer: ${(err as Error).message}`);
            }
          };
          authed.get("/demo/bank", async () => ({ behaviour: (await callBank("GET", "/_admin/state")).behaviour }));
          authed.post("/demo/bank", async (req) => ({
            behaviour: await callBank("POST", "/_admin/behaviour", bankBehaviourBody.parse(req.body)),
          }));
        }
      });
    },
    { prefix: "/me" },
  );
}
