import type pg from "pg";
import { listAllBankPayouts, type BankClient, type BankPayout } from "../bank/client.js";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { requeueDeadEvent } from "../outbox/outbox.js";
import { applyCheckoutSessionEvent, type SessionFields } from "../payments/deposits.js";
import { listAllStripeSessions, type StripeRecordSource, type StripeSessionRecord } from "../payments/stripe.js";
import { applyProviderState, PAYOUT_SUBMIT_EVENT } from "../payouts/payouts.js";
import {
  CONTROL,
  fingerprint,
  ledgerPositions,
  lockBreakKey,
  objectBreakKey,
  samePosition,
  ZERO,
  type Classification,
  type Disagreement,
  type Position,
  type ReconSource,
} from "./positions.js";

export interface ReconProviders {
  bank?: BankClient;
  stripe?: StripeRecordSource;
}

export type ItemOutcome = "open" | "auto_resolved" | "in_transit" | "acknowledged";

export interface ReconItem extends Disagreement {
  break_key: string;
  object_type: "payout" | "deposit" | "order";
  object_id: string | null;
  account_id: string | null;
  provider_ref: string | null;
  outcome: ItemOutcome;
  currency: string;
  auto_action: string | null;
  auto_transfer_ids: string[];
  fingerprint: string;
  detail: string;
}

/** Per dimension: does the ledger total equal the provider total, once every item's difference is counted? */
export interface DimensionProof {
  ledger_cents: number;
  provider_cents: number;
  /** Sum of (ledger − provider) over the items that still disagree after the run. */
  explained_cents: number;
  /** Money on the control account that belongs to no item. Must be 0. */
  unattributed_cents: number;
  /** ledger − provider = explained + unattributed, and unattributed = 0. */
  balanced: boolean;
}

export interface ReconRun {
  id: string;
  source: ReconSource;
  currency: string;
  status: "running" | "completed" | "failed";
  provider_records: number | null;
  ledger_records: number | null;
  matched: number | null;
  in_transit: number | null;
  auto_resolved: number | null;
  open_breaks: number | null;
  acknowledged: number | null;
  totals: Partial<Record<keyof Position, DimensionProof>> | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const RUN_COLUMNS =
  "id, source, currency, status, provider_records, ledger_records, matched, in_transit, auto_resolved, open_breaks, " +
  "acknowledged, totals, error, started_at, finished_at";

/** One thing to compare: what we have, what the provider has. Either side may be missing. */
interface Pair<Ours, Theirs> {
  key: string;
  ours?: Ours;
  theirs?: Theirs;
}

interface OurPayout {
  id: string;
  account_id: string;
  amount_cents: number;
  status: string;
  submit_event_status: string | null;
  submit_event_id: string | null;
}

/** A deposit, or a ticket order: both are paid through a Stripe Checkout session. */
interface OurDeposit {
  type: "deposit" | "order";
  id: string;
  account_id: string | null;
  amount_cents: number;
  status: string;
  stripe_checkout_session_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPOSIT_OPEN = new Set(["created", "pending", "processing"]);
const PAYOUT_OPEN = new Set(["pending", "submitted"]);

/** What the bank's record says about the money. */
function bankPosition(p: BankPayout | undefined): Position {
  if (!p) return { ...ZERO };
  if (p.status === "processing") return { held: p.amount_cents, settled: 0 };
  if (p.status === "succeeded") return { held: 0, settled: p.amount_cents };
  return { ...ZERO }; // failed: never left. returned: left and came back.
}

/** What Stripe's record says: money collected for us, if the session was paid. */
function stripePosition(s: StripeSessionRecord | undefined): Position {
  if (!s || s.payment_status !== "paid" || s.amount_total === null) return { ...ZERO };
  return { held: 0, settled: s.amount_total };
}

function classify(hasOurs: boolean, hasTheirs: boolean, sameAmount: boolean): Classification {
  if (!hasTheirs) return "missing_at_provider";
  if (!hasOurs) return "missing_in_ledger";
  if (!sameAmount) return "amount_mismatch";
  return "status_mismatch";
}

const fmt = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

function describe(d: Disagreement, source: ReconSource, currency: string): string {
  const who = source === "mock_bank" ? "The bank" : "Stripe";
  const parts: string[] = [];
  if (d.classification === "missing_at_provider") parts.push(`${who} has no record of this ${source === "mock_bank" ? "payout" : "payment"}.`);
  if (d.classification === "missing_in_ledger") parts.push(`${who} has a record we have nothing for (${d.provider_status}, ${fmt(d.provider_amount_cents ?? 0, currency)}).`);
  if (d.classification === "amount_mismatch") {
    parts.push(`${who} has ${fmt(d.provider_amount_cents ?? 0, currency)}, we have ${fmt(d.our_amount_cents ?? 0, currency)}.`);
  }
  if (d.classification === "status_mismatch") parts.push(`${who} says ${d.provider_status}, we recorded ${d.our_status}.`);
  const dims: (keyof Position)[] = source === "mock_bank" ? ["held", "settled"] : ["settled"];
  const label = { held: source === "mock_bank" ? "in flight" : "held", settled: source === "mock_bank" ? "paid out" : "collected" };
  for (const k of dims) {
    if (d.ledger[k] !== d.provider[k]) parts.push(`${label[k]}: ledger ${fmt(d.ledger[k], currency)}, ${who.toLowerCase()} ${fmt(d.provider[k], currency)}.`);
  }
  return parts.join(" ");
}

/**
 * Run one reconciliation: read the provider's statement for a currency,
 * compare it with the ledger item by item, fix what the provider's record
 * settles on its own, and store everything that was found.
 *
 * The comparison is about money, not labels. For each payout or deposit
 * (or provider record we know nothing about) it compares where the LEDGER
 * says the money is (from the transfers on the control accounts) with where
 * the PROVIDER says it is. Equal: matched. Different: a break, classified as
 *
 *   missing_at_provider   we have money against it; the provider has no record
 *   missing_in_ledger     the provider has a record; we have nothing for it
 *   amount_mismatch       both have it, with different amounts
 *   status_mismatch       same amount, but the money is in a different place
 *
 * What the run fixes by itself, and only this: an item still open on our side
 * (a pending payout, an uncredited deposit) where the provider's record says
 * how it ended. That goes through the same function as a webhook, so it can
 * only move money forward, and only once. A provider contradicting a final
 * state of ours is never "fixed" by code: it is an open break for a person.
 *
 * A pending payout the bank has never heard of is not a break yet: it is in
 * transit. If nothing is going to send it again (its submit event is dead),
 * the run queues it again, with the same idempotency key.
 *
 * Every page of the statement is read before anything is compared. If the
 * provider fails mid-way, the run is recorded as failed and changes nothing:
 * a partial statement would make every payout on the missing pages look lost.
 */
export async function runReconciliation(
  pool: pg.Pool,
  source: ReconSource,
  currency: string,
  providers: ReconProviders,
): Promise<ReconRun> {
  const provider = source === "mock_bank" ? providers.bank : providers.stripe;
  if (!provider) {
    throw new ApiError(503, "provider_not_configured", `No ${source} client is configured, so its records cannot be read.`);
  }

  // One run per source and currency at a time. A session-level advisory lock
  // on a dedicated connection: released if this process dies.
  const lock = await pool.connect();
  let run: ReconRun | undefined;
  try {
    const { rows: got } = await lock.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('recon-run:' || $1 || ':' || $2, 0)) AS ok",
      [source, currency],
    );
    if (!got[0].ok) throw new ApiError(409, "run_in_progress", `A ${source} ${currency} reconciliation is already running.`);
    try {
      // Holding the lock, any run still marked running is one whose process died.
      await pool.query(
        `UPDATE reconciliation_runs SET status = 'failed', error = 'abandoned: the process running it stopped', finished_at = now()
          WHERE source = $1 AND currency = $2 AND status = 'running'`,
        [source, currency],
      );
      const { rows } = await pool.query<ReconRun>(
        `INSERT INTO reconciliation_runs (source, currency) VALUES ($1, $2) RETURNING ${RUN_COLUMNS}`,
        [source, currency],
      );
      run = rows[0];

      let records: BankPayout[] | StripeSessionRecord[];
      try {
        records =
          source === "mock_bank"
            ? await listAllBankPayouts(provider as BankClient, AbortSignal.timeout(30_000))
            : await listAllStripeSessions(provider as StripeRecordSource);
      } catch (err) {
        return await finishFailed(pool, run.id, `could not read the ${source} statement: ${(err as Error).message}`);
      }
      const items =
        source === "mock_bank"
          ? await compareBank(pool, currency, records as BankPayout[])
          : await compareStripe(pool, currency, records as StripeSessionRecord[]);
      return await finishCompleted(pool, run.id, source, currency, items);
    } catch (err) {
      if (run && !(err instanceof ApiError)) await finishFailed(pool, run.id, (err as Error).message).catch(() => {});
      throw err;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('recon-run:' || $1 || ':' || $2, 0))", [source, currency]);
    }
  } finally {
    lock.release();
  }
}

interface Compared {
  items: ReconItem[];
  providerRecords: number;
  ledgerRecords: number;
  matched: number;
  /** Provider's totals over the records in this currency. */
  providerTotals: Position;
}

async function compareBank(pool: pg.Pool, currency: string, statement: BankPayout[]): Promise<Compared> {
  const records = statement.filter((p) => p.currency === currency);
  const { rows: ours } = await pool.query<OurPayout>(
    `SELECT p.id, p.account_id, p.amount_cents, p.status, o.status AS submit_event_status, o.event_id AS submit_event_id
       FROM payouts p
       LEFT JOIN LATERAL (
         SELECT status, event_id FROM outbox
          WHERE aggregate_type = 'payout' AND aggregate_id = p.id AND event_type = $2
          ORDER BY id DESC LIMIT 1
       ) o ON true
      WHERE p.currency = $1`,
    [currency, PAYOUT_SUBMIT_EVENT],
  );
  const pairs = new Map<string, Pair<OurPayout, BankPayout>>();
  for (const p of ours) pairs.set(objectBreakKey("mock_bank", p.id), { key: objectBreakKey("mock_bank", p.id), ours: p });
  for (const r of records) {
    // We send payout:<our id> as the idempotency key, so that is how a bank record finds its payout.
    const ourId = r.idempotency_key.startsWith("payout:") ? r.idempotency_key.slice("payout:".length) : "";
    const key = UUID_RE.test(ourId) && pairs.has(`payout:${ourId}`) ? `payout:${ourId}` : `bank_payout:${r.id}`;
    const pair = pairs.get(key) ?? { key };
    pair.theirs = r;
    pairs.set(key, pair);
  }

  const providerTotals = records.reduce(
    (t, r) => {
      const p = bankPosition(r);
      return { held: t.held + p.held, settled: t.settled + p.settled };
    },
    { ...ZERO },
  );

  const { byKey: ledger } = await ledgerPositions(pool, "mock_bank", currency);
  // Money the ledger attributes to an item neither side has any more (e.g. a
  // resolution posted for a bank record that has since vanished).
  for (const key of ledger.keys()) if (!pairs.has(key)) pairs.set(key, { key });

  const items: ReconItem[] = [];
  let matched = 0;
  for (const pair of pairs.values()) {
    const found = evaluate(pair, ledger.get(pair.key) ?? { ...ZERO }, bankPosition(pair.theirs), {
      ourAmount: pair.ours?.amount_cents,
      theirAmount: pair.theirs?.amount_cents,
      ourStatus: pair.ours?.status,
      theirStatus: pair.theirs?.status,
    });
    if (!found) {
      matched++;
      continue;
    }
    const base = {
      break_key: pair.key,
      object_type: "payout" as const,
      object_id: pair.ours?.id ?? null,
      account_id: pair.ours?.account_id ?? null,
      provider_ref: pair.theirs?.id ?? null,
      currency,
    };

    // In transit: we hold it, the bank has not received it. Not a break, and
    // never "failed" on a guess. Make sure something is going to send it.
    if (pair.ours?.status === "pending" && !pair.theirs) {
      let action: string | null = null;
      if (pair.ours.submit_event_status === "dead" && pair.ours.submit_event_id) {
        if (await requeueDeadEvent(pool, pair.ours.submit_event_id)) action = "resubmitted";
      }
      items.push(item(base, found, "in_transit", "mock_bank", action, []));
      continue;
    }

    // Still open on our side, and the bank's record says how it went: apply
    // it, the same way a webhook or a status lookup would.
    if (pair.ours && pair.theirs && PAYOUT_OPEN.has(pair.ours.status) && found.classification === "status_mismatch") {
      const ourId = pair.ours.id;
      const theirs = pair.theirs;
      const { outcome, transferIds, after } = await withTransaction(pool, async (c) => {
        await lockBreakKey(c, pair.key);
        const before = await stepTransfers(c, ourId);
        const { outcome } = await applyProviderState(c, ourId, theirs, "reconciliation");
        const transferIds = (await stepTransfers(c, ourId)).filter((t) => !before.includes(t));
        const after = (await ledgerPositions(c, "mock_bank", currency, pair.key)).byKey.get(pair.key) ?? { ...ZERO };
        return { outcome, transferIds, after };
      });
      if (samePosition(after, bankPosition(theirs))) {
        items.push(item(base, found, "auto_resolved", "mock_bank", `applied bank status ${theirs.status} (${outcome})`, transferIds));
        continue;
      }
      found.ledger = after;
    }
    items.push(await openOrAcknowledged(pool, item(base, found, "open", "mock_bank", null, [])));
  }
  return { items, providerRecords: records.length, ledgerRecords: ours.length, matched, providerTotals };
}

async function compareStripe(pool: pg.Pool, currency: string, sessions: StripeSessionRecord[]): Promise<Compared> {
  const records = sessions.filter((s) => s.currency?.toUpperCase() === currency);
  const { rows: ours } = await pool.query<OurDeposit>(
    `SELECT 'deposit' AS type, id, account_id, amount_cents, status, stripe_checkout_session_id FROM deposits WHERE currency = $1
     UNION ALL
     SELECT 'order', id, NULL, amount_cents, status, stripe_checkout_session_id FROM orders WHERE currency = $1`,
    [currency],
  );
  const pairs = new Map<string, Pair<OurDeposit, StripeSessionRecord>>();
  const byId = new Map(ours.map((d) => [`${d.type}:${d.id}`, d]));
  const keyOf = (d: OurDeposit) => objectBreakKey("stripe", d.id, d.type);
  for (const d of ours) pairs.set(keyOf(d), { key: keyOf(d), ours: d });
  for (const s of records) {
    // Ticket orders carry order_id in their metadata; deposits, deposit_id (and both the id as client_reference_id).
    const ref = s.metadata?.order_id ? `order:${s.metadata.order_id}` : `deposit:${s.client_reference_id ?? s.metadata?.deposit_id ?? ""}`;
    const deposit = byId.get(ref);
    // A session belongs to a deposit or order if it points at it and is the session we saved for it.
    const mine = deposit && (deposit.stripe_checkout_session_id === null || deposit.stripe_checkout_session_id === s.id);
    const key = mine ? keyOf(deposit) : `stripe_session:${s.id}`;
    const pair = pairs.get(key) ?? { key };
    if (pair.theirs) {
      // A second session pointing at the same deposit. Only one can be ours; keep the paid one.
      if (s.payment_status !== "paid") continue;
      pairs.set(`stripe_session:${pair.theirs.id}`, { key: `stripe_session:${pair.theirs.id}`, theirs: pair.theirs });
    }
    pair.theirs = s;
    pairs.set(key, pair);
  }

  const providerTotals = records.reduce((t, s) => ({ held: 0, settled: t.settled + stripePosition(s).settled }), { ...ZERO });
  const { byKey: ledger } = await ledgerPositions(pool, "stripe", currency);
  for (const key of ledger.keys()) if (!pairs.has(key)) pairs.set(key, { key });

  const items: ReconItem[] = [];
  let matched = 0;
  for (const pair of pairs.values()) {
    const theirs = pair.theirs;
    const found = evaluate(pair, ledger.get(pair.key) ?? { ...ZERO }, stripePosition(theirs), {
      ourAmount: pair.ours?.amount_cents,
      theirAmount: theirs?.amount_total ?? undefined,
      ourStatus: pair.ours?.status,
      theirStatus: theirs ? `${theirs.status ?? "unknown"}/${theirs.payment_status}` : undefined,
    });
    if (!found) {
      matched++;
      continue;
    }
    const base = {
      break_key: pair.key,
      object_type: pair.ours?.type ?? (pair.key.startsWith("order:") ? ("order" as const) : ("deposit" as const)),
      object_id: pair.ours?.id ?? null,
      account_id: pair.ours?.account_id ?? null,
      provider_ref: theirs?.id ?? null,
      currency,
    };

    // Stripe was paid and the webhook never reached us (endpoint down, user
    // closed the tab, a misconfigured secret). Credit it through the webhook's
    // own code path. If Stripe collected a different amount, that path puts
    // the deposit in requires_review instead, and the break stays open.
    if (pair.ours && theirs && DEPOSIT_OPEN.has(pair.ours.status) && theirs.payment_status === "paid") {
      const { id: objectId, type } = pair.ours;
      const { outcome, status, transferIds, after } = await withTransaction(pool, async (c) => {
        await lockBreakKey(c, pair.key);
        const { outcome } = await applyCheckoutSessionEvent(c, "checkout.session.completed", toSessionFields(theirs));
        const { rows } = await c.query<{ transfer_ids: string[]; status: string }>(
          type === "deposit"
            ? "SELECT CASE WHEN transfer_id IS NULL THEN '{}'::text[] ELSE ARRAY[transfer_id::text] END AS transfer_ids, status FROM deposits WHERE id = $1"
            : `SELECT COALESCE((SELECT array_agg(t.id::text ORDER BY t.created_at, t.id) FROM transfers t
                                 WHERE t.idempotency_scope = 'system' AND t.idempotency_key LIKE 'order:' || o.id || ':%'), '{}') AS transfer_ids,
                      o.status
                 FROM orders o WHERE o.id = $1`,
          [objectId],
        );
        const after = (await ledgerPositions(c, "stripe", currency, pair.key)).byKey.get(pair.key) ?? { ...ZERO };
        return { outcome, status: rows[0].status, transferIds: rows[0].transfer_ids, after };
      });
      if (samePosition(after, stripePosition(theirs))) {
        items.push(item(base, found, "auto_resolved", "stripe", `applied Stripe's paid session (${outcome})`, transferIds));
        continue;
      }
      found.ledger = after;
      found.our_status = status;
    }
    items.push(await openOrAcknowledged(pool, item(base, found, "open", "stripe", null, [])));
  }
  return { items, providerRecords: records.length, ledgerRecords: ours.length, matched, providerTotals };
}

function toSessionFields(s: StripeSessionRecord): SessionFields {
  return {
    id: s.id,
    client_reference_id: s.client_reference_id,
    metadata: s.metadata,
    payment_status: s.payment_status as SessionFields["payment_status"],
    amount_total: s.amount_total,
    currency: s.currency,
    payment_intent: s.payment_intent,
  };
}

/** Compare one item's positions. undefined: they agree. */
function evaluate(
  pair: { ours?: unknown; theirs?: unknown },
  ledger: Position,
  provider: Position,
  facts: { ourAmount?: number; theirAmount?: number; ourStatus?: string; theirStatus?: string },
): Disagreement | undefined {
  if (samePosition(ledger, provider)) return undefined;
  return {
    classification: classify(pair.ours !== undefined, pair.theirs !== undefined, facts.ourAmount === facts.theirAmount),
    our_status: facts.ourStatus ?? null,
    provider_status: facts.theirStatus ?? null,
    our_amount_cents: facts.ourAmount ?? null,
    provider_amount_cents: facts.theirAmount ?? null,
    ledger,
    provider,
  };
}

function item(
  base: Pick<ReconItem, "break_key" | "object_type" | "object_id" | "account_id" | "provider_ref" | "currency">,
  d: Disagreement,
  outcome: ItemOutcome,
  source: ReconSource,
  autoAction: string | null,
  transferIds: string[],
): ReconItem {
  return {
    ...base,
    ...d,
    outcome,
    auto_action: autoAction,
    auto_transfer_ids: transferIds,
    fingerprint: fingerprint(d),
    detail: describe(d, source, base.currency),
  };
}

/** A person already resolved exactly this disagreement (same fingerprint) on an earlier run. */
async function openOrAcknowledged(pool: pg.Pool, it: ReconItem): Promise<ReconItem> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM reconciliation_resolutions WHERE break_key = $1 AND fingerprint = $2 AND action <> 'acknowledge_flag'",
    [it.break_key, it.fingerprint],
  );
  return rowCount ? { ...it, outcome: "acknowledged" } : it;
}

/** The ledger transfers a payout has posted so far. */
async function stepTransfers(c: pg.PoolClient, payoutId: string): Promise<string[]> {
  const { rows } = await c.query<{ ids: (string | null)[] }>(
    "SELECT ARRAY[hold_transfer_id, settle_transfer_id, reverse_transfer_id, return_transfer_id]::text[] AS ids FROM payouts WHERE id = $1",
    [payoutId],
  );
  return (rows[0]?.ids ?? []).filter((x): x is string => x !== null);
}

async function finishFailed(pool: pg.Pool, runId: string, error: string): Promise<ReconRun> {
  const { rows } = await pool.query<ReconRun>(
    `UPDATE reconciliation_runs SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status = 'running' RETURNING ${RUN_COLUMNS}`,
    [runId, error],
  );
  return rows[0];
}

async function finishCompleted(
  pool: pg.Pool,
  runId: string,
  source: ReconSource,
  currency: string,
  compared: Compared,
): Promise<ReconRun> {
  return withTransaction(pool, async (c) => {
    for (const it of compared.items) {
      await c.query(
        `INSERT INTO reconciliation_items
           (run_id, break_key, object_type, object_id, account_id, provider_ref, classification, outcome, currency,
            our_status, provider_status, our_amount_cents, provider_amount_cents,
            ledger_held_cents, ledger_settled_cents, provider_held_cents, provider_settled_cents,
            auto_action, auto_transfer_ids, fingerprint, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          runId, it.break_key, it.object_type, it.object_id, it.account_id, it.provider_ref, it.classification, it.outcome,
          it.currency, it.our_status, it.provider_status, it.our_amount_cents, it.provider_amount_cents,
          it.ledger.held, it.ledger.settled, it.provider.held, it.provider.settled,
          it.auto_action, it.auto_transfer_ids, it.fingerprint, it.detail,
        ],
      );
    }

    // The proof, from the books as they stand after the run's own fixes:
    // ledger total − provider total must equal the sum of what the remaining
    // items disagree by, with nothing left over that no item explains.
    const { balances, unattributed } = await ledgerPositions(c, source, currency);
    const remaining = compared.items.filter((i) => i.outcome !== "auto_resolved");
    const totals: Partial<Record<keyof Position, DimensionProof>> = {};
    for (const dim of CONTROL[source]) {
      const k = dim.dimension;
      const explained = remaining.reduce((sum, i) => sum + (i.ledger[k] - i.provider[k]), 0);
      const ledger = balances[k];
      const providerTotal = compared.providerTotals[k];
      totals[k] = {
        ledger_cents: ledger,
        provider_cents: providerTotal,
        explained_cents: explained,
        unattributed_cents: unattributed[k],
        balanced: unattributed[k] === 0 && ledger - providerTotal === explained,
      };
    }
    const count = (o: ItemOutcome) => compared.items.filter((i) => i.outcome === o).length;
    const { rows } = await c.query<ReconRun>(
      `UPDATE reconciliation_runs
          SET status = 'completed', finished_at = now(), provider_records = $2, ledger_records = $3, matched = $4,
              in_transit = $5, auto_resolved = $6, open_breaks = $7, acknowledged = $8, totals = $9
        WHERE id = $1 AND status = 'running'
        RETURNING ${RUN_COLUMNS}`,
      [
        runId, compared.providerRecords, compared.ledgerRecords, compared.matched,
        count("in_transit"), count("auto_resolved"), count("open"), count("acknowledged"), JSON.stringify(totals),
      ],
    );
    return rows[0];
  });
}

export async function getRun(pool: pg.Pool, id: string): Promise<ReconRun | undefined> {
  const { rows } = await pool.query<ReconRun>(`SELECT ${RUN_COLUMNS} FROM reconciliation_runs WHERE id = $1`, [id]);
  return rows[0];
}

export async function listRuns(pool: pg.Pool, limit = 20): Promise<ReconRun[]> {
  const { rows } = await pool.query<ReconRun>(
    `SELECT ${RUN_COLUMNS} FROM reconciliation_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
