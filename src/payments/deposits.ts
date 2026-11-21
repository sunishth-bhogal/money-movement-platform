import { createHash } from "node:crypto";
import type pg from "pg";
import type Stripe from "stripe";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { recordEventOnce } from "../ledger/events.js";
import { createTransferInTx } from "../ledger/transfers.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import type { CheckoutGateway } from "./stripe.js";

export type DepositStatus =
  | "created"
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "expired"
  | "requires_review";

const FINAL: ReadonlySet<DepositStatus> = new Set(["succeeded", "failed", "expired", "requires_review"]);

export interface Deposit {
  id: string;
  idempotency_key: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  status: DepositStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  checkout_url: string | null;
  transfer_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DepositRequest {
  account_id: string;
  amount_cents: number;
  currency: string;
}

const DEPOSIT_COLUMNS =
  "id, idempotency_key, request_hash, account_id, amount_cents, currency, status, stripe_checkout_session_id, " +
  "stripe_payment_intent_id, checkout_url, transfer_id, failure_reason, created_at, updated_at";

type DepositRow = Deposit & { request_hash: string };

function toDeposit({ request_hash: _hash, ...d }: DepositRow): Deposit {
  return d;
}

function hashDepositRequest(req: DepositRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([req.account_id, req.amount_cents, req.currency]))
    .digest("hex");
}

async function findByKey(db: pg.Pool | pg.PoolClient, key: string): Promise<DepositRow | undefined> {
  const { rows } = await db.query<DepositRow>(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE idempotency_key = $1`, [key]);
  return rows[0];
}

export async function getDeposit(pool: pg.Pool, id: string): Promise<Deposit | undefined> {
  const { rows } = await pool.query<DepositRow>(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id = $1`, [id]);
  return rows[0] && toDeposit(rows[0]);
}

/**
 * Start a deposit: record it, then open a Stripe Checkout session for it.
 *
 * Two steps, because a Stripe call cannot be inside a Postgres transaction:
 *
 *  1. Commit a `created` deposit row, keyed by the client's Idempotency-Key.
 *  2. Call Stripe with an idempotency key derived from the deposit id, then
 *     save the session and move to `pending`.
 *
 * If step 2 fails or the process dies in between, the row stays `created`.
 * A retry with the same Idempotency-Key finds it and repeats step 2, and
 * Stripe's own idempotency returns the same session rather than a second one.
 * No money moves here: the ledger is only touched by the webhook.
 */
export async function createDeposit(
  pool: pg.Pool,
  gateway: CheckoutGateway,
  idempotencyKey: string,
  req: DepositRequest,
  appBaseUrl: string,
): Promise<{ deposit: Deposit; replayed: boolean }> {
  const requestHash = hashDepositRequest(req);

  const { row, replayed } = await withTransaction(pool, async (client) => {
    const existing = await findByKey(client, idempotencyKey);
    if (existing) return { row: existing, replayed: true };

    const { rows: accounts } = await client.query<{ kind: string; currency: string }>(
      "SELECT kind, currency FROM accounts WHERE id = $1",
      [req.account_id],
    );
    const account = accounts[0];
    if (!account || account.kind !== "user") throw new ApiError(404, "account_not_found", "Account not found.");
    if (account.currency !== req.currency) {
      throw new ApiError(422, "currency_mismatch", "The account does not hold this currency.");
    }

    const { rows: inserted } = await client.query<DepositRow>(
      `INSERT INTO deposits (idempotency_key, request_hash, account_id, amount_cents, currency)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${DEPOSIT_COLUMNS}`,
      [idempotencyKey, requestHash, req.account_id, req.amount_cents, req.currency],
    );
    if (inserted[0]) return { row: inserted[0], replayed: false };
    const winner = await findByKey(client, idempotencyKey);
    if (!winner) throw new Error("idempotency conflict but no deposit found");
    return { row: winner, replayed: true };
  });

  if (row.request_hash !== requestHash) {
    throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
  }
  if (row.status !== "created") return { deposit: toDeposit(row), replayed };

  let session: { id: string; url: string };
  try {
    session = await gateway.createCheckoutSession(
      {
        depositId: row.id,
        amountCents: row.amount_cents,
        currency: row.currency,
        successUrl: `${appBaseUrl}/deposits/${row.id}?checkout=success`,
        cancelUrl: `${appBaseUrl}/deposits/${row.id}?checkout=cancelled`,
      },
      `deposit-checkout:${row.id}`,
    );
  } catch (err) {
    throw new ApiError(502, "payment_provider_error", `Could not create a Stripe Checkout session: ${(err as Error).message}`);
  }

  // Only move forward from `created`. If a webhook already advanced this
  // deposit (it finds deposits by client_reference_id), keep its state.
  await pool.query(
    `UPDATE deposits
        SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2),
            checkout_url = $3,
            status = CASE WHEN status = 'created' THEN 'pending' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [row.id, session.id, session.url],
  );
  const { rows } = await pool.query<DepositRow>(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id = $1`, [row.id]);
  return { deposit: toDeposit(rows[0]), replayed };
}

/** Find, or create on first use, the system account that mirrors money held at Stripe. */
async function stripeClearingAccount(client: pg.PoolClient, currency: string): Promise<string> {
  await client.query(
    `INSERT INTO accounts (name, currency, kind, system_code)
     VALUES ($1, $2, 'system', 'stripe_clearing')
     ON CONFLICT (system_code, currency) WHERE system_code IS NOT NULL DO NOTHING`,
    [`Stripe clearing (${currency})`, currency],
  );
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE system_code = 'stripe_clearing' AND currency = $1",
    [currency],
  );
  return rows[0].id;
}

export type WebhookOutcome =
  | "duplicate" // this event id was already processed
  | "ignored" // not an event we act on, or not one of our deposits
  | "already_final" // the deposit had already reached a final state
  | `deposit_${DepositStatus}`; // the deposit moved to this status

type CheckoutSessionEvent =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed"
  | "checkout.session.expired";

const CHECKOUT_EVENTS: ReadonlySet<string> = new Set<CheckoutSessionEvent>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

/** The fields of a Checkout Session that we rely on. */
interface SessionFields {
  id: string;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | { id: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply a verified Stripe event exactly once.
 *
 * Everything happens in ONE transaction: recording the event id in
 * processed_events, moving the deposit's state, and posting the ledger
 * transfer. So either all of it commits or none of it does, and a crash
 * midway means Stripe's redelivery is processed from scratch.
 *
 * Three layers stop a payment being credited twice:
 *  1. processed_events (provider, event_id) PK: the same event delivered
 *     twice, or concurrently, is applied once.
 *  2. The deposit row is locked (FOR UPDATE) and only a non-final deposit is
 *     credited. This covers *different* events for one payment, e.g.
 *     `checkout.session.completed` followed by `async_payment_succeeded`.
 *  3. The ledger transfer's idempotency key is `deposit:<id>`, and the
 *     database requires status = succeeded exactly when transfer_id is set.
 */
export async function handleStripeEvent(pool: pg.Pool, event: Stripe.Event): Promise<{ outcome: WebhookOutcome; deposit_id?: string }> {
  return withTransaction(pool, async (client) => {
    const firstTime = await recordEventOnce(client, {
      provider: "stripe",
      eventId: event.id,
      type: event.type,
      payload: event,
    });
    if (!firstTime) return { outcome: "duplicate" };
    if (!CHECKOUT_EVENTS.has(event.type)) return { outcome: "ignored" };
    return applyCheckoutSessionEvent(client, event.type as CheckoutSessionEvent, event.data.object as unknown as SessionFields);
  });
}

async function applyCheckoutSessionEvent(
  client: pg.PoolClient,
  type: CheckoutSessionEvent,
  session: SessionFields,
): Promise<{ outcome: WebhookOutcome; deposit_id?: string }> {
  const depositId = session.client_reference_id ?? session.metadata?.deposit_id;
  if (!depositId || !UUID_RE.test(depositId)) return { outcome: "ignored" };

  // Serialises all events for this deposit.
  const { rows } = await client.query<DepositRow>(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id = $1 FOR UPDATE`, [
    depositId,
  ]);
  const deposit = rows[0];
  if (!deposit) return { outcome: "ignored" };
  // A session we did not create for this deposit (we save the id when we create it).
  if (deposit.stripe_checkout_session_id && deposit.stripe_checkout_session_id !== session.id) {
    return { outcome: "ignored", deposit_id: deposit.id };
  }
  if (FINAL.has(deposit.status)) return { outcome: "already_final", deposit_id: deposit.id };

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  const setStatus = async (status: DepositStatus, extra: { transferId?: string; reason?: string } = {}) => {
    await client.query(
      `UPDATE deposits
          SET status = $2,
              transfer_id = COALESCE($3, transfer_id),
              failure_reason = $4,
              stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $5),
              stripe_payment_intent_id = COALESCE($6, stripe_payment_intent_id),
              updated_at = now()
        WHERE id = $1`,
      [deposit.id, status, extra.transferId ?? null, extra.reason ?? null, session.id, paymentIntentId],
    );
    // Same transaction as the status change (and the ledger posting, if any).
    await enqueueOutboxEvent(client, {
      eventType: `deposit.${status}`,
      aggregateType: "deposit",
      aggregateId: deposit.id,
      payload: {
        id: deposit.id,
        account_id: deposit.account_id,
        amount_cents: deposit.amount_cents,
        currency: deposit.currency,
        status,
        transfer_id: extra.transferId ?? null,
        failure_reason: extra.reason ?? null,
      },
    });
    return { outcome: `deposit_${status}` as WebhookOutcome, deposit_id: deposit.id };
  };

  const paid =
    type === "checkout.session.async_payment_succeeded" ||
    (type === "checkout.session.completed" && session.payment_status === "paid");

  if (paid) {
    // Credit what we asked for, and only if Stripe collected exactly that.
    if (session.amount_total !== deposit.amount_cents || session.currency?.toUpperCase() !== deposit.currency) {
      return setStatus("requires_review", {
        reason: `amount_mismatch: expected ${deposit.amount_cents} ${deposit.currency}, got ${session.amount_total} ${session.currency}`,
      });
    }
    const clearing = await stripeClearingAccount(client, deposit.currency);
    // A `system`-scoped key: no API client can have used it first.
    const { transfer } = await createTransferInTx(
      client,
      `deposit:${deposit.id}`,
      {
        from_account_id: clearing,
        to_account_id: deposit.account_id,
        amount_cents: deposit.amount_cents,
        currency: deposit.currency,
      },
      { scope: "system" },
    );
    return setStatus("succeeded", { transferId: transfer.id });
  }
  if (type === "checkout.session.completed") return setStatus("processing"); // async method (e.g. bank debit) pending
  if (type === "checkout.session.async_payment_failed") return setStatus("failed", { reason: "async_payment_failed" });
  return setStatus("expired", { reason: "checkout_session_expired" });
}
