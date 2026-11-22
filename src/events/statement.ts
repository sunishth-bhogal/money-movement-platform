import type pg from "pg";
import type { PostingKind } from "../organizers/postings.js";
import { releaseDueAt } from "./catalog.js";
import { formatCents } from "./money.js";

/**
 * The organizer's payout statement: "you sold $X; here are the fees,
 * refunds and adjustments; here is why your payout is $Y".
 *
 * It is not a report computed beside the ledger. It IS the ledger: every
 * line is a ledger entry on one of the organizer's two accounts, labelled by
 * the organizer_postings row the database required when it was written
 * (which names the event, order, ticket, refund, dispute, payout or person's
 * decision). So the lines of a payout always add up to the payout, and the
 * statement checks that they do (`balanced`).
 *
 * A payout always takes the organizer's whole available balance, so a
 * payout's statement is everything that reached that balance since the
 * previous payout:
 *
 *   - each release or early payout of an event's held money, opened up into
 *     that event's sales, fees, refunds and chargebacks (minus what was paid
 *     out early before, and what is still held back);
 *   - anything that hit the balance directly: a refund or chargeback after the
 *     event was paid out (which can make it negative), money a bank sent
 *     back, a person's adjustment, a reconciliation correction.
 */

export interface StatementItem {
  transfer_id: string;
  amount_cents: number;
  memo: string;
  bucket: "held" | "available";
  order_id: string | null;
  ticket_id: string | null;
  refund_id: string | null;
  dispute_id: string | null;
  payout_id: string | null;
  adjustment_id: string | null;
  resolution_id: string | null;
  buyer_name: string | null;
  tickets: number | null;
  created_at: string;
}

export interface StatementLine {
  kind: PostingKind | "earlier_payouts" | "held_back";
  label: string;
  amount_cents: number;
  /** Tickets sold, refunds made, chargebacks... (whatever the line counts). */
  count: number;
  items: StatementItem[];
}

export interface StatementSection {
  /** null for lines that belong to no event (adjustments, money back from the bank). */
  event: { id: string; name: string; starts_at: string; ends_at: string; status: string; share_bps: number } | null;
  title: string;
  lines: StatementLine[];
  total_cents: number;
}

export interface PayoutStatement {
  payout: {
    id: string;
    amount_cents: number;
    currency: string;
    status: string;
    failure_reason: string | null;
    event_id: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  /** The available balance just before this window (normally 0: the previous payout took it all). */
  opening_balance_cents: number;
  sections: StatementSection[];
  /** opening + every section: the payout amount (or, for the upcoming statement, the current balance). */
  total_cents: number;
  /** total_cents equals the payout's amount. Always true unless the books are broken. */
  balanced: boolean;
  /** The statement in sentences. */
  summary: string[];
}

export interface HeldEvent {
  event: NonNullable<StatementSection["event"]> & { release_due_at: string; released_at: string | null; advance_bps: number };
  held_cents: number;
  section: StatementSection;
}

export interface OrganizerOverview {
  organizer: { id: string; name: string; currency: string; bank_account_last4: string };
  balances: {
    /** Proceeds of events that have not happened yet (plus their hold period). */
    held_cents: number;
    /** Released and not yet paid out. Negative: the organizer owes this much. */
    available_cents: number;
    /** Paid out and on its way: the bank has not confirmed it yet. */
    in_flight_cents: number;
    owed_by_organizer_cents: number;
  };
  /** What the next payout would look like right now (or what is owed). */
  upcoming: PayoutStatement;
  held: HeldEvent[];
  payouts: PayoutStatement[];
}

interface Row {
  entry_id: number;
  amount_cents: number;
  bucket: "held" | "available";
  transfer_id: string;
  kind: PostingKind;
  event_id: string | null;
  order_id: string | null;
  ticket_id: string | null;
  refund_id: string | null;
  dispute_id: string | null;
  payout_id: string | null;
  adjustment_id: string | null;
  resolution_id: string | null;
  memo: string;
  buyer_name: string | null;
  tickets: number | null;
  created_at: Date;
}

const LABEL: Record<StatementLine["kind"], string> = {
  ticket_sale: "Tickets sold",
  platform_fee: "Platform fees",
  refund: "Refunds to customers",
  fee_returned: "Platform fees returned on refunds and chargebacks",
  dispute: "Chargebacks",
  dispute_fee: "Chargeback fees",
  dispute_won: "Chargebacks won",
  release: "Released after the event",
  advance: "Paid out early",
  payout: "Payouts",
  payout_failed: "Payouts the bank did not make",
  payout_returned: "Payouts sent back by the receiving bank",
  adjustment: "Adjustments",
  reconciliation: "Reconciliation corrections",
  earlier_payouts: "Already paid out early",
  held_back: "Held back until after the event",
};

/** Lines in the order a person reads a statement. */
const ORDER: StatementLine["kind"][] = [
  "ticket_sale",
  "platform_fee",
  "refund",
  "fee_returned",
  "dispute",
  "dispute_fee",
  "dispute_won",
  "earlier_payouts",
  "held_back",
  "payout_failed",
  "payout_returned",
  "adjustment",
  "reconciliation",
];

const MOVES: ReadonlySet<PostingKind> = new Set(["release", "advance"]);

function item(r: Row, amount = r.amount_cents): StatementItem {
  return {
    transfer_id: r.transfer_id,
    amount_cents: amount,
    memo: r.memo,
    bucket: r.bucket,
    order_id: r.order_id,
    ticket_id: r.ticket_id,
    refund_id: r.refund_id,
    dispute_id: r.dispute_id,
    payout_id: r.payout_id,
    adjustment_id: r.adjustment_id,
    resolution_id: r.resolution_id,
    buyer_name: r.buyer_name,
    tickets: r.tickets,
    created_at: r.created_at.toISOString(),
  };
}

function countFor(kind: StatementLine["kind"], items: StatementItem[]): number {
  if (kind === "ticket_sale") return items.reduce((n, i) => n + (i.tickets ?? 0), 0);
  // One refund or dispute can post up to two entries (held and available); count it once.
  const ids = items.map((i) => i.refund_id ?? i.dispute_id ?? i.adjustment_id ?? i.payout_id ?? i.transfer_id);
  return new Set(ids).size;
}

function toLines(entries: { kind: StatementLine["kind"]; item: StatementItem }[]): StatementLine[] {
  const by = new Map<StatementLine["kind"], StatementItem[]>();
  for (const e of entries) by.set(e.kind, [...(by.get(e.kind) ?? []), e.item]);
  return ORDER.filter((k) => by.has(k)).map((kind) => {
    const items = by.get(kind)!;
    return { kind, label: LABEL[kind], amount_cents: items.reduce((s, i) => s + i.amount_cents, 0), count: countFor(kind, items), items };
  });
}

/** Build every statement for one organizer from their ledger. */
export async function organizerOverview(pool: pg.Pool | pg.PoolClient, organizerId: string): Promise<OrganizerOverview | undefined> {
  const { rows: orgRows } = await pool.query<{
    id: string;
    name: string;
    currency: string;
    bank_account_number: string;
    held: number;
    available: number;
  }>(
    `SELECT o.id, o.name, o.currency, o.bank_account_number, h.balance_cents AS held, a.balance_cents AS available
       FROM organizers o JOIN accounts h ON h.id = o.held_account_id JOIN accounts a ON a.id = o.available_account_id
      WHERE o.id = $1`,
    [organizerId],
  );
  const org = orgRows[0];
  if (!org) return undefined;

  const { rows } = await pool.query<Row>(
    `SELECT e.id AS entry_id, e.amount_cents,
            CASE WHEN e.account_id = o.held_account_id THEN 'held' ELSE 'available' END AS bucket,
            p.transfer_id, p.kind, p.event_id, p.order_id, p.ticket_id, p.refund_id, p.dispute_id, p.payout_id,
            p.adjustment_id, p.resolution_id, p.memo, ord.buyer_name,
            CASE WHEN p.kind = 'ticket_sale' THEN (SELECT count(*)::int FROM tickets t WHERE t.order_id = p.order_id) END AS tickets,
            e.created_at
       FROM organizer_postings p
       JOIN organizers o ON o.id = p.organizer_id
       JOIN ledger_entries e ON e.transfer_id = p.transfer_id AND e.account_id IN (o.held_account_id, o.available_account_id)
       LEFT JOIN orders ord ON ord.id = p.order_id
      WHERE p.organizer_id = $1
      ORDER BY e.id`,
    [organizerId],
  );
  const { rows: events } = await pool.query<{
    id: string;
    name: string;
    starts_at: Date;
    ends_at: Date;
    hold_hours: number;
    status: string;
    released_at: Date | null;
    advance_bps: number;
    share_bps: number;
  }>(
    `SELECT e.id, e.name, e.starts_at, e.ends_at, e.hold_hours, e.status, e.released_at, e.advance_bps, eo.share_bps
       FROM events e JOIN event_organizers eo ON eo.event_id = e.id
      WHERE eo.organizer_id = $1 ORDER BY e.starts_at, e.id`,
    [organizerId],
  );
  const { rows: payouts } = await pool.query<{
    id: string;
    amount_cents: number;
    currency: string;
    status: string;
    failure_reason: string | null;
    event_id: string | null;
    hold_transfer_id: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, amount_cents, currency, status, failure_reason, event_id, hold_transfer_id, created_at, updated_at
       FROM payouts WHERE organizer_id = $1 AND status <> 'rejected' ORDER BY created_at, id`,
    [organizerId],
  );
  const { rows: inFlight } = await pool.query<{ total: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM payouts WHERE organizer_id = $1 AND status IN ('pending', 'submitted')",
    [organizerId],
  );

  const eventInfo = new Map(
    events.map((e) => [
      e.id,
      {
        id: e.id,
        name: e.name,
        starts_at: e.starts_at.toISOString(),
        ends_at: e.ends_at.toISOString(),
        status: e.status === "cancelled" ? "cancelled" : e.released_at ? "paid_out" : e.ends_at.getTime() <= Date.now() ? "ended" : "upcoming",
        share_bps: e.share_bps,
      },
    ]),
  );
  const cur = org.currency;
  const available = rows.filter((r) => r.bucket === "available");
  const held = rows.filter((r) => r.bucket === "held");

  /** The section for one release or advance: the event's held lines before it, less earlier moves and what stays held. */
  const expandMove = (move: Row): StatementSection => {
    const eventId = move.event_id!;
    const before = held.filter((r) => r.event_id === eventId && r.entry_id < move.entry_id && r.transfer_id !== move.transfer_id);
    const entries: { kind: StatementLine["kind"]; item: StatementItem }[] = before
      .filter((r) => !MOVES.has(r.kind))
      .map((r) => ({ kind: r.kind, item: item(r) }));
    const earlier = before.filter((r) => MOVES.has(r.kind));
    for (const r of earlier) entries.push({ kind: "earlier_payouts", item: item(r) });
    // The move itself is an entry pair: −held, +available. What is left held after it is held back.
    const moveHeld = held.find((r) => r.transfer_id === move.transfer_id);
    const leftHeld = before.reduce((s, r) => s + r.amount_cents, 0) + (moveHeld?.amount_cents ?? 0);
    if (leftHeld > 0) {
      entries.push({
        kind: "held_back",
        item: { ...item(move, -leftHeld), memo: "Still held: released after the event, if it goes ahead" },
      });
    }
    const lines = toLines(entries);
    const info = eventInfo.get(eventId) ?? null;
    return {
      event: info,
      title: `${info?.name ?? "Event"}: ${move.kind === "advance" ? "paid out early" : "released after the event"}`,
      lines,
      total_cents: move.amount_cents,
    };
  };

  /** Everything that reached the available balance in (from, to) entry ids, as sections. */
  const window = (fromEntry: number, toEntry: number, exclude?: string): { opening: number; sections: StatementSection[] } => {
    const opening = available.filter((r) => r.entry_id <= fromEntry).reduce((s, r) => s + r.amount_cents, 0);
    const inside = available.filter((r) => r.entry_id > fromEntry && r.entry_id < toEntry && r.transfer_id !== exclude);
    const sections: StatementSection[] = [];
    const direct = new Map<string, { kind: StatementLine["kind"]; item: StatementItem }[]>();
    for (const r of inside) {
      if (MOVES.has(r.kind)) {
        sections.push(expandMove(r));
        continue;
      }
      // A payout leaving is the boundary of a window, not a line inside one.
      if (r.kind === "payout") continue;
      const accountLevel = r.kind === "payout_failed" || r.kind === "payout_returned" || r.kind === "adjustment" || r.kind === "reconciliation";
      const key = !accountLevel && r.event_id ? r.event_id : "";
      direct.set(key, [...(direct.get(key) ?? []), { kind: r.kind, item: item(r) }]);
    }
    for (const [eventId, entries] of direct) {
      const lines = toLines(entries);
      const info = eventId ? (eventInfo.get(eventId) ?? null) : null;
      sections.push({
        event: info,
        title: info ? `${info.name}: after it was paid out` : "Your account",
        lines,
        total_cents: lines.reduce((s, l) => s + l.amount_cents, 0),
      });
    }
    return { opening, sections };
  };

  const summarize = (opening: number, sections: StatementSection[], total: number, what: "payout" | "upcoming"): string[] => {
    const sum = (kind: StatementLine["kind"]) => {
      let amount = 0;
      let count = 0;
      for (const s of sections) for (const l of s.lines) if (l.kind === kind) {
        amount += l.amount_cents;
        count += l.count;
      }
      return { amount, count };
    };
    const out: string[] = [];
    const sold = sum("ticket_sale");
    if (sold.count > 0) out.push(`You sold ${formatCents(sold.amount, cur)} in tickets (${sold.count} ticket${sold.count === 1 ? "" : "s"}).`);
    const fees = sum("platform_fee");
    const back = sum("fee_returned");
    if (fees.amount) out.push(`Platform fees: ${formatCents(fees.amount + back.amount, cur)}${back.amount ? ` (after ${formatCents(back.amount, cur)} returned on refunds and chargebacks)` : ""}.`);
    const refunds = sum("refund");
    if (refunds.count) out.push(`Refunds to customers: ${formatCents(refunds.amount, cur)} (${refunds.count}).`);
    const cb = sum("dispute");
    const cbFee = sum("dispute_fee");
    const cbWon = sum("dispute_won");
    if (cb.count) out.push(`Chargebacks: ${formatCents(cb.amount + cbFee.amount, cur)} including ${formatCents(cbFee.amount, cur)} in fees${cbWon.amount ? `, ${formatCents(cbWon.amount, cur)} won back` : ""}.`);
    const early = sum("earlier_payouts");
    if (early.amount) out.push(`Already paid to you early: ${formatCents(early.amount, cur)}.`);
    const heldBack = sum("held_back");
    if (heldBack.amount) out.push(`Still held until the event: ${formatCents(-heldBack.amount, cur)}.`);
    const bank = sum("payout_failed").amount + sum("payout_returned").amount;
    if (bank) out.push(`Earlier payouts the bank sent back: ${formatCents(bank, cur)}.`);
    const adj = sum("adjustment").amount + sum("reconciliation").amount;
    if (adj) out.push(`Adjustments: ${formatCents(adj, cur)} (each with its reason below).`);
    if (opening < 0) out.push(`You owed ${formatCents(-opening, cur)} from before.`);
    if (opening > 0) out.push(`Carried over: ${formatCents(opening, cur)}.`);
    if (what === "payout") out.push(`So this payout is ${formatCents(total, cur)}.`);
    else if (total > 0) out.push(`So your next payout is ${formatCents(total, cur)} so far.`);
    else if (total < 0) out.push(`So you owe ${formatCents(-total, cur)}. It comes out of your next payout before anything is paid to you.`);
    else out.push(out.length ? "These cancel out: nothing is waiting to be paid out." : "Nothing is waiting to be paid out.");
    return out;
  };

  const holdEntry = (transferId: string) => available.find((r) => r.transfer_id === transferId && r.kind === "payout")?.entry_id;
  const statements: PayoutStatement[] = [];
  let prev = 0;
  for (const p of payouts) {
    const at = holdEntry(p.hold_transfer_id);
    if (at === undefined) continue;
    const { opening, sections } = window(prev, at);
    const total = opening + sections.reduce((s, x) => s + x.total_cents, 0);
    statements.push({
      payout: {
        id: p.id,
        amount_cents: p.amount_cents,
        currency: p.currency,
        status: p.status,
        failure_reason: p.failure_reason,
        event_id: p.event_id,
        created_at: p.created_at.toISOString(),
        updated_at: p.updated_at.toISOString(),
      },
      opening_balance_cents: opening,
      sections,
      total_cents: total,
      balanced: total === p.amount_cents,
      summary: summarize(opening, sections, total, "payout"),
    });
    prev = at;
  }
  const upcomingWindow = window(prev, Number.MAX_SAFE_INTEGER);
  const upcomingTotal = upcomingWindow.opening + upcomingWindow.sections.reduce((s, x) => s + x.total_cents, 0);

  const heldEvents: HeldEvent[] = [];
  for (const e of events) {
    const lines = held.filter((r) => r.event_id === e.id);
    const heldNow = lines.reduce((s, r) => s + r.amount_cents, 0);
    if (e.released_at || (lines.length === 0 && e.status === "cancelled")) continue;
    const entries = lines.map((r) => ({ kind: (MOVES.has(r.kind) ? "earlier_payouts" : r.kind) as StatementLine["kind"], item: item(r) }));
    const info = eventInfo.get(e.id)!;
    heldEvents.push({
      event: { ...info, release_due_at: releaseDueAt(e).toISOString(), released_at: null, advance_bps: e.advance_bps },
      held_cents: heldNow,
      section: { event: info, title: `${e.name}: held until after the event`, lines: toLines(entries), total_cents: heldNow },
    });
  }

  return {
    organizer: { id: org.id, name: org.name, currency: cur, bank_account_last4: org.bank_account_number.slice(-4) },
    balances: {
      held_cents: org.held,
      available_cents: org.available,
      in_flight_cents: inFlight[0].total,
      owed_by_organizer_cents: Math.max(0, -org.available),
    },
    upcoming: {
      payout: null,
      opening_balance_cents: upcomingWindow.opening,
      sections: upcomingWindow.sections,
      total_cents: upcomingTotal,
      balanced: upcomingTotal === org.available,
      summary: summarize(upcomingWindow.opening, upcomingWindow.sections, upcomingTotal, "upcoming"),
    },
    held: heldEvents,
    payouts: statements.reverse(),
  };
}
