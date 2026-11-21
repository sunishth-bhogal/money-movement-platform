import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { enqueueOutboxEvent } from "../outbox/outbox.js";

export interface TransferRequest {
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  currency: string;
}

export interface Transfer extends TransferRequest {
  id: string;
  idempotency_key: string;
  status: "posted" | "rejected";
  failure_reason: string | null;
  created_at: Date;
}

/**
 * Who chose the idempotency key. Client keys (`api`) and keys built by our own
 * code (`system`, e.g. `deposit:<id>`) are separate namespaces, so a client can
 * never claim a key that internal code will need later.
 *
 * `api` transfers may only move money between user accounts. Only internal
 * code may move money out of a system account (which is allowed to go
 * negative), otherwise any caller could mint money.
 */
export type IdempotencyScope = "api" | "system";

export interface TransferOptions {
  scope?: IdempotencyScope;
}

export interface TransferResult {
  transfer: Transfer;
  /** true when this call did not create the transfer but returned the stored result of an earlier one. */
  replayed: boolean;
}

/** Stable fingerprint of the request body, so a reused key with a different body is detected. */
export function hashRequest(req: TransferRequest): string {
  const canonical = JSON.stringify([req.from_account_id, req.to_account_id, req.amount_cents, req.currency]);
  return createHash("sha256").update(canonical).digest("hex");
}

const TRANSFER_COLUMNS =
  "id, idempotency_key, request_hash, from_account_id, to_account_id, amount_cents, currency, status, failure_reason, created_at";

type TransferRow = Transfer & { request_hash: string };

function toTransfer({ request_hash: _hash, ...t }: TransferRow): Transfer {
  return t;
}

async function findByKey(client: pg.PoolClient, scope: IdempotencyScope, key: string): Promise<TransferRow | undefined> {
  const { rows } = await client.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE idempotency_scope = $1 AND idempotency_key = $2`,
    [scope, key],
  );
  return rows[0];
}

function replay(existing: TransferRow, requestHash: string): TransferResult {
  if (existing.request_hash !== requestHash) {
    throw new ApiError(
      422,
      "idempotency_key_reused",
      "This Idempotency-Key was already used with a different request body.",
    );
  }
  return { transfer: toTransfer(existing), replayed: true };
}

/**
 * Move money between two accounts exactly once per idempotency key.
 *
 * Everything below runs in ONE database transaction, so the outcome is
 * all-or-nothing: either the transfer row, both ledger legs and both balance
 * updates commit together, or none of them do.
 *
 *  1. Fast path: if the key already exists, return the stored result.
 *  2. Lock both account rows in a fixed order (by id) so that two transfers
 *     touching the same pair of accounts in opposite directions cannot deadlock.
 *  3. Check funds while holding the lock: no other transfer can change the
 *     balance until we commit, so check-then-write is safe.
 *  4. Insert the transfer row. The UNIQUE(idempotency_key) index is the real
 *     arbiter for a concurrent duplicate: ON CONFLICT DO NOTHING waits for the
 *     other transaction, and if it committed we return its result instead.
 *  5. Append the two ledger entries (debit + credit). A trigger updates the
 *     cached balances; a deferred trigger checks the entries sum to zero.
 *  6. Write a `transfer.posted` / `transfer.rejected` outbox event. It commits
 *     with the transfer or not at all, and the outbox worker publishes it.
 */
export async function createTransfer(
  pool: pg.Pool,
  idempotencyKey: string,
  req: TransferRequest,
  opts: TransferOptions = {},
): Promise<TransferResult> {
  return withTransaction(pool, (client) => createTransferInTx(client, idempotencyKey, req, opts));
}

/**
 * The body of createTransfer, for callers that already hold a transaction and
 * need the transfer to commit atomically with their own writes (e.g. a webhook
 * that must record the event and post the deposit together).
 */
export async function createTransferInTx(
  client: pg.PoolClient,
  idempotencyKey: string,
  req: TransferRequest,
  { scope = "api" }: TransferOptions = {},
): Promise<TransferResult> {
  if (req.from_account_id === req.to_account_id) {
    throw new ApiError(400, "same_account", "from_account_id and to_account_id must differ.");
  }
  const requestHash = hashRequest(req);
  // 1. Already processed?
  const existing = await findByKey(client, scope, idempotencyKey);
  if (existing) return replay(existing, requestHash);

  // 2. Lock both accounts in id order. FOR NO KEY UPDATE is the weakest row
  //    lock that still serialises balance changes. Unlike FOR UPDATE it does
  //    not block the FOR KEY SHARE locks that foreign-key checks take, so
  //    other inserts that merely *reference* an account are not held up.
  const { rows: accounts } = await client.query<{
    id: string;
    currency: string;
    kind: "user" | "system";
    balance_cents: number;
  }>(
    `SELECT id, currency, kind, balance_cents
       FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
        FOR NO KEY UPDATE`,
    [[req.from_account_id, req.to_account_id]],
  );
  const from = accounts.find((a) => a.id === req.from_account_id);
  const to = accounts.find((a) => a.id === req.to_account_id);
  if (!from || !to) throw new ApiError(404, "account_not_found", "One or both accounts do not exist.");
  if (from.currency !== req.currency || to.currency !== req.currency) {
    throw new ApiError(422, "currency_mismatch", "Both accounts must hold the transfer currency.");
  }
  if (scope === "api" && (from.kind !== "user" || to.kind !== "user")) {
    throw new ApiError(403, "system_account_not_allowed", "Transfers may only move money between user accounts.");
  }

  // 3. Funds check under lock. System accounts may go negative.
  const insufficient = from.kind === "user" && from.balance_cents < req.amount_cents;
  const status = insufficient ? "rejected" : "posted";
  const failureReason = insufficient ? "insufficient_funds" : null;

  // 4. Claim the idempotency key.
  const { rows: inserted } = await client.query<TransferRow>(
    `INSERT INTO transfers
       (idempotency_scope, idempotency_key, request_hash, from_account_id, to_account_id, amount_cents, currency, status, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
     RETURNING ${TRANSFER_COLUMNS}`,
    [scope, idempotencyKey, requestHash, from.id, to.id, req.amount_cents, req.currency, status, failureReason],
  );
  if (inserted.length === 0) {
    // A concurrent request with the same key committed first. We have
    // written nothing yet; return its stored result.
    const winner = await findByKey(client, scope, idempotencyKey);
    if (!winner) throw new Error("idempotency conflict but no row found");
    return replay(winner, requestHash);
  }
  const transfer = inserted[0];

  // 5. Double-entry posting.
  if (status === "posted") {
    await client.query(
      `INSERT INTO ledger_entries (transfer_id, account_id, amount_cents, currency)
       VALUES ($1, $2, $3, $5), ($1, $4, $6, $5)`,
      [transfer.id, from.id, -req.amount_cents, to.id, req.currency, req.amount_cents],
    );
  }

  // 6. Same transaction, so the event exists exactly when the transfer does.
  const result = toTransfer(transfer);
  await enqueueOutboxEvent(client, {
    eventType: `transfer.${status}`,
    aggregateType: "transfer",
    aggregateId: result.id,
    payload: { ...result, created_at: result.created_at.toISOString() },
  });
  return { transfer: result, replayed: false };
}

export async function getTransfer(pool: pg.Pool, id: string): Promise<Transfer | undefined> {
  const { rows } = await pool.query<TransferRow>(`SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE id = $1`, [id]);
  return rows[0] && toTransfer(rows[0]);
}
