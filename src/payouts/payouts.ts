import { createHash } from "node:crypto";
import type pg from "pg";
import type { BankPayout, BankPayoutStatus } from "../bank/client.js";
import type { BankWebhookEvent } from "../bank/mockBank.js";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { recordEventOnce } from "../ledger/events.js";
import { createTransferInTx } from "../ledger/transfers.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";
import { recordOrganizerPosting } from "../organizers/postings.js";

export type PayoutStatus = "rejected" | "pending" | "submitted" | "succeeded" | "failed" | "returned";

export interface Payout {
  id: string;
  idempotency_key: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  bank_account_number: string;
  status: PayoutStatus;
  provider_payout_id: string | null;
  failure_reason: string | null;
  hold_transfer_id: string | null;
  settle_transfer_id: string | null;
  reverse_transfer_id: string | null;
  return_transfer_id: string | null;
  discrepancy: string | null;
  /** Set for a payout to an event organizer; account_id is then their available balance. */
  organizer_id: string | null;
  /** The event whose release (or advance) created this payout, if any. */
  event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutRequest {
  account_id: string;
  amount_cents: number;
  currency: string;
  bank_account_number: string;
}

/** The outbox event type that asks the worker to send a payout to the bank. */
export const PAYOUT_SUBMIT_EVENT = "payout.submit";

/** The provider name in processed_events. */
export const BANK_PROVIDER = "mock_bank";

const PAYOUT_COLUMNS =
  "id, idempotency_key, request_hash, account_id, amount_cents, currency, bank_account_number, status, " +
  "provider_payout_id, failure_reason, hold_transfer_id, settle_transfer_id, reverse_transfer_id, " +
  "return_transfer_id, discrepancy, organizer_id, event_id, created_at, updated_at";

type PayoutRow = Payout & { request_hash: string };

function toPayout({ request_hash: _hash, ...p }: PayoutRow): Payout {
  return p;
}

function hashPayoutRequest(req: PayoutRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([req.account_id, req.amount_cents, req.currency, req.bank_account_number]))
    .digest("hex");
}

/** The key we send to the bank. One payout, one key, for every attempt, forever. */
export function bankIdempotencyKey(payoutId: string): string {
  return `payout:${payoutId}`;
}

export async function getPayout(db: pg.Pool | pg.PoolClient, id: string): Promise<Payout | undefined> {
  const { rows } = await db.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1`, [id]);
  return rows[0] && toPayout(rows[0]);
}

/** Find, or create on first use, a system account by its code. */
export async function systemAccount(client: pg.PoolClient, code: string, name: string, currency: string): Promise<string> {
  await client.query(
    `INSERT INTO accounts (name, currency, kind, system_code)
     VALUES ($1, $2, 'system', $3)
     ON CONFLICT (system_code, currency) WHERE system_code IS NOT NULL DO NOTHING`,
    [`${name} (${currency})`, currency, code],
  );
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE system_code = $1 AND currency = $2",
    [code, currency],
  );
  return rows[0].id;
}

/** Holds money for payouts the bank has not finished. Its balance equals the open payouts' total. */
export const inFlightAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "payouts_in_flight", "Payouts in flight", currency);
/** Money the bank has paid out on our behalf. Stage 5 reconciles this against the bank's records. */
export const bankPayoutsAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "bank_payouts", "Bank payouts", currency);

async function enqueuePayoutEvent(client: pg.PoolClient, payout: Payout) {
  await enqueueOutboxEvent(client, {
    eventType: `payout.${payout.status}`,
    aggregateType: "payout",
    aggregateId: payout.id,
    payload: {
      id: payout.id,
      account_id: payout.account_id,
      amount_cents: payout.amount_cents,
      currency: payout.currency,
      status: payout.status,
      failure_reason: payout.failure_reason,
      provider_payout_id: payout.provider_payout_id,
    },
  });
}

/**
 * Request a payout. ONE transaction, and no network call:
 *
 *  1. Insert the payout under the client's Idempotency-Key (a retry returns it).
 *  2. Hold the money: a transfer from the user to "Payouts in flight", under
 *     the key payout:<id>:hold. The usual row lock and funds check apply, so
 *     concurrent payouts cannot overspend. Not enough money: `rejected`.
 *  3. Write a `payout.submit` outbox event. The outbox worker sends it to the
 *     bank after commit, with retries. So the hold and the instruction to pay
 *     commit together: money is never held for a payout nobody will send, and
 *     a payout is never sent without its money held.
 */
export async function createPayout(
  pool: pg.Pool,
  idempotencyKey: string,
  req: PayoutRequest,
): Promise<{ payout: Payout; replayed: boolean }> {
  return withTransaction(pool, (client) => createPayoutInTx(client, idempotencyKey, req));
}

/** For a payout to an organizer: whose, and why (shown on their statement). */
export interface OrganizerPayoutContext {
  organizerId: string;
  eventId?: string | null;
  memo: string;
}

/**
 * The body of createPayout, for callers that already hold a transaction (the
 * organizer payout schedule releases an event's money and pays it out in one).
 *
 * With `organizer`, the account must be that organizer's available balance,
 * which may be negative for other reasons, so the hold is made with
 * requireFunds: a payout never takes it below zero.
 */
export async function createPayoutInTx(
  client: pg.PoolClient,
  idempotencyKey: string,
  req: PayoutRequest,
  organizer?: OrganizerPayoutContext,
): Promise<{ payout: Payout; replayed: boolean }> {
  const requestHash = hashPayoutRequest(req);
  const replay = (row: PayoutRow) => {
    if (row.request_hash !== requestHash) {
      throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.");
    }
    return { payout: toPayout(row), replayed: true };
  };

  const { rows: existing } = await client.query<PayoutRow>(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing[0]) return replay(existing[0]);

  const { rows: accounts } = await client.query<{ kind: string; currency: string }>(
    "SELECT kind, currency FROM accounts WHERE id = $1",
    [req.account_id],
  );
  const account = accounts[0];
  if (!account || account.kind !== (organizer ? "organizer" : "user")) {
    throw new ApiError(404, "account_not_found", "Account not found.");
  }
  if (account.currency !== req.currency) {
    throw new ApiError(422, "currency_mismatch", "The account does not hold this currency.");
  }

  const { rows: inserted } = await client.query<PayoutRow>(
    `INSERT INTO payouts (idempotency_key, request_hash, account_id, amount_cents, currency, bank_account_number, organizer_id, event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${PAYOUT_COLUMNS}`,
    [
      idempotencyKey,
      requestHash,
      req.account_id,
      req.amount_cents,
      req.currency,
      req.bank_account_number,
      organizer?.organizerId ?? null,
      organizer?.eventId ?? null,
    ],
  );
  if (!inserted[0]) {
    // A concurrent request with this key committed first.
    const { rows } = await client.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    return replay(rows[0]);
  }
  const payout = inserted[0];

  const { transfer: hold } = await createTransferInTx(
    client,
    `payout:${payout.id}:hold`,
    {
      from_account_id: payout.account_id,
      to_account_id: await inFlightAccount(client, payout.currency),
      amount_cents: payout.amount_cents,
      currency: payout.currency,
    },
    { scope: "system", requireFunds: true },
  );
  if (organizer && hold.status === "posted") {
    await recordOrganizerPosting(client, hold.id, organizer.organizerId, "payout", organizer.memo, {
      payoutId: payout.id,
      eventId: organizer.eventId,
    });
  }
  const status: PayoutStatus = hold.status === "posted" ? "pending" : "rejected";
  const { rows } = await client.query<PayoutRow>(
    `UPDATE payouts SET status = $2, hold_transfer_id = $3, failure_reason = $4, updated_at = now()
      WHERE id = $1 RETURNING ${PAYOUT_COLUMNS}`,
    [payout.id, status, hold.id, hold.failure_reason],
  );
  const result = toPayout(rows[0]);
  await enqueuePayoutEvent(client, result);
  if (status === "pending") {
    await enqueueOutboxEvent(client, {
      eventType: PAYOUT_SUBMIT_EVENT,
      aggregateType: "payout",
      aggregateId: result.id,
      payload: { payout_id: result.id },
    });
  }
  return { payout: result, replayed: false };
}

export type ProviderUpdateOutcome =
  | "submitted" // the bank acknowledged it and is processing
  | "succeeded"
  | "failed"
  | "returned"
  | "no_change" // nothing new (a repeat, or stale news)
  | "discrepancy" // the bank contradicts what we recorded; flagged, no money moved
  | "unknown_payout";

/** Where the bank's word came from. Logged in discrepancies; the logic is the same for all of them. */
export type ProviderSource = "submit_response" | "webhook" | "status_lookup" | "reconciliation";

const OPEN: ReadonlySet<PayoutStatus> = new Set(["pending", "submitted"]);

/**
 * Bring our payout in line with what the bank says about it. The single place
 * where a payout's status and its ledger postings change after creation, used
 * by the response to our submit, by webhooks, and by the status poller. The
 * three can arrive in any order, any number of times, so this is written as
 * "move towards the bank's state", not "react to this message":
 *
 *   ours \ bank   processing   succeeded        failed           returned
 *   pending       → submitted  → succeeded      → failed         → succeeded → returned
 *   submitted     no change    → succeeded      → failed         → succeeded → returned
 *   succeeded     no change    no change        DISCREPANCY      → returned
 *   failed        no change    DISCREPANCY      no change        DISCREPANCY
 *   returned      no change    no change        DISCREPANCY      no change
 *   rejected      DISCREPANCY (we never sent it)
 *
 * "No change" for an older status is stale news (a slow lookup or an old
 * webhook arriving late), never a reason to move backwards. A discrepancy is
 * the bank contradicting itself or us: the money cannot be moved safely by
 * code (the user may already have spent a reversal), so it is recorded for a
 * person and nothing moves. The same happens if the bank's amount, currency
 * or payout id differ from ours.
 *
 * Must run inside a transaction. Locks the payout row first, then (through
 * createTransferInTx) account rows, the same order as createPayout.
 */
export async function applyProviderState(
  client: pg.PoolClient,
  payoutId: string,
  bank: Pick<BankPayout, "id" | "status" | "amount_cents" | "currency" | "failure_code">,
  source: ProviderSource,
): Promise<{ outcome: ProviderUpdateOutcome; payout?: Payout }> {
  const { rows } = await client.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
  if (!rows[0]) return { outcome: "unknown_payout" };
  const payout = toPayout(rows[0]);

  const flag = async (problem: string) => {
    const note = `${new Date().toISOString()} ${source}: ${problem}`;
    const { rows: updated } = await client.query<PayoutRow>(
      `UPDATE payouts SET discrepancy = concat_ws(E'\\n', discrepancy, $2::text), updated_at = now()
        WHERE id = $1 RETURNING ${PAYOUT_COLUMNS}`,
      [payout.id, note],
    );
    await enqueueOutboxEvent(client, {
      eventType: "payout.discrepancy",
      aggregateType: "payout",
      aggregateId: payout.id,
      payload: { id: payout.id, our_status: payout.status, bank_status: bank.status, problem },
    });
    return { outcome: "discrepancy" as const, payout: toPayout(updated[0]) };
  };

  if (payout.provider_payout_id && payout.provider_payout_id !== bank.id) {
    return flag(`bank payout id ${bank.id} differs from recorded ${payout.provider_payout_id}`);
  }
  if (bank.amount_cents !== payout.amount_cents || bank.currency !== payout.currency) {
    return flag(`bank has ${bank.amount_cents} ${bank.currency}, we have ${payout.amount_cents} ${payout.currency}`);
  }
  if (payout.status === "rejected") return flag(`bank reports ${bank.status} for a payout we never sent`);

  const ours = payout.status;
  const theirs: BankPayoutStatus = bank.status;
  const contradiction =
    (ours === "succeeded" && theirs === "failed") ||
    (ours === "returned" && theirs === "failed") ||
    (ours === "failed" && (theirs === "succeeded" || theirs === "returned"));
  if (contradiction) return flag(`bank reports ${theirs}, we recorded ${ours}`);

  const post = async (step: "settle" | "reverse" | "return", from: string, to: string) => {
    const { transfer } = await createTransferInTx(
      client,
      `payout:${payout.id}:${step}`,
      { from_account_id: from, to_account_id: to, amount_cents: payout.amount_cents, currency: payout.currency },
      { scope: "system" },
    );
    // Money coming back to an organizer goes on their statement, with the bank's reason.
    if (payout.organizer_id && step !== "settle") {
      const why = bank.failure_code ? ` (${bank.failure_code})` : "";
      await recordOrganizerPosting(
        client,
        transfer.id,
        payout.organizer_id,
        step === "reverse" ? "payout_failed" : "payout_returned",
        step === "reverse" ? `The bank did not pay out this payout${why}; the money is back in your balance` : `The receiving bank sent this payout back${why}; the money is back in your balance`,
        { payoutId: payout.id, eventId: payout.event_id },
      );
    }
    return transfer.id;
  };

  let next: PayoutStatus = ours;
  const set: { settle?: string; reverse?: string; ret?: string } = {};
  if (OPEN.has(ours) && theirs === "processing") next = "submitted";
  if (OPEN.has(ours) && (theirs === "succeeded" || theirs === "returned")) {
    set.settle = await post("settle", await inFlightAccount(client, payout.currency), await bankPayoutsAccount(client, payout.currency));
    next = "succeeded";
  }
  if (OPEN.has(ours) && theirs === "failed") {
    set.reverse = await post("reverse", await inFlightAccount(client, payout.currency), payout.account_id);
    next = "failed";
  }
  if ((ours === "succeeded" || next === "succeeded") && theirs === "returned") {
    set.ret = await post("return", await bankPayoutsAccount(client, payout.currency), payout.account_id);
    next = "returned";
  }

  const learnedId = payout.provider_payout_id === null;
  if (next === ours && !learnedId) return { outcome: "no_change", payout };

  const { rows: updated } = await client.query<PayoutRow>(
    `UPDATE payouts
        SET status = $2,
            provider_payout_id = COALESCE(provider_payout_id, $3),
            settle_transfer_id = COALESCE($4, settle_transfer_id),
            reverse_transfer_id = COALESCE($5, reverse_transfer_id),
            return_transfer_id = COALESCE($6, return_transfer_id),
            failure_reason = CASE WHEN $2 IN ('failed', 'returned') THEN $7 ELSE failure_reason END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${PAYOUT_COLUMNS}`,
    [payout.id, next, bank.id, set.settle ?? null, set.reverse ?? null, set.ret ?? null, bank.failure_code],
  );
  const result = toPayout(updated[0]);
  if (next === ours) return { outcome: "no_change", payout: result };
  // A pending payout that the bank already finished goes straight to its final status; one event says so.
  await enqueuePayoutEvent(client, result);
  return { outcome: next as ProviderUpdateOutcome, payout: result };
}

export type BankWebhookOutcome = "duplicate" | "ignored" | ProviderUpdateOutcome;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEBHOOK_TYPES: ReadonlySet<string> = new Set(["payout.succeeded", "payout.failed", "payout.returned"]);

/**
 * Apply a verified bank webhook exactly once: the event id is recorded in
 * processed_events in the same transaction as its effects, so a duplicate
 * delivery (routine: banks resend on any timeout) is skipped, and a crash
 * midway leaves nothing behind for the redelivery to trip over.
 *
 * The event's status is not trusted on its own merits: it goes through
 * applyProviderState, so an out-of-order or contradictory event cannot move
 * money the wrong way.
 */
export async function handleBankWebhook(
  pool: pg.Pool,
  event: BankWebhookEvent,
): Promise<{ outcome: BankWebhookOutcome; payout_id?: string }> {
  return withTransaction(pool, async (client) => {
    const firstTime = await recordEventOnce(client, { provider: BANK_PROVIDER, eventId: event.id, type: event.type, payload: event });
    if (!firstTime) return { outcome: "duplicate" };
    if (!WEBHOOK_TYPES.has(event.type) || !event.data || !UUID_RE.test(event.data.reference ?? "")) {
      return { outcome: "ignored" };
    }
    const { outcome } = await applyProviderState(client, event.data.reference, event.data, "webhook");
    return { outcome: outcome === "unknown_payout" ? "ignored" : outcome, payout_id: event.data.reference };
  });
}

/**
 * Invariants that tie payouts to the ledger. Empty means they hold.
 *  - "Payouts in flight" holds exactly the open payouts' money.
 *  - "Bank payouts" holds exactly the succeeded payouts' money.
 * Both plus whatever reconciliation resolutions have posted to them: a person
 * correcting the books is the one other thing allowed to move this money, and
 * every such transfer is linked to the resolution that made it.
 */
export async function checkPayoutInvariants(pool: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const { rows } = await pool.query<{ code: string; currency: string; balance: number; expected: number }>(
    `SELECT a.system_code AS code, a.currency, a.balance_cents AS balance,
            COALESCE((SELECT SUM(amount_cents) FROM payouts p
                       WHERE p.currency = a.currency
                         AND CASE a.system_code
                               WHEN 'payouts_in_flight' THEN p.status IN ('pending', 'submitted')
                               ELSE p.status = 'succeeded' END), 0)::bigint
          + COALESCE((SELECT SUM(e.amount_cents) FROM ledger_entries e
                        JOIN reconciliation_resolution_postings rp ON rp.transfer_id = e.transfer_id
                       WHERE e.account_id = a.id), 0)::bigint AS expected
       FROM accounts a
      WHERE a.system_code IN ('payouts_in_flight', 'bank_payouts')`,
  );
  for (const r of rows) {
    if (r.balance !== r.expected) problems.push(`${r.code} ${r.currency}: balance ${r.balance}, payouts say ${r.expected}`);
  }
  return problems;
}
