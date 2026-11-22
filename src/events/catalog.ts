import type pg from "pg";
import { withTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { createTransferInTx } from "../ledger/transfers.js";
import { recordOrganizerPosting, type PostingContext, type PostingKind } from "../organizers/postings.js";

export interface Organizer {
  id: string;
  name: string;
  currency: string;
  bank_account_number: string;
  held_account_id: string;
  available_account_id: string;
  created_at: Date;
}

export interface EventRow {
  id: string;
  name: string;
  venue: string;
  currency: string;
  starts_at: Date;
  ends_at: Date;
  fee_bps: number;
  fee_fixed_cents: number;
  hold_hours: number;
  advance_bps: number;
  status: "on_sale" | "cancelled";
  cancelled_at: Date | null;
  cancel_reason: string | null;
  released_at: Date | null;
  created_at: Date;
}

export interface EventOrganizer {
  organizer_id: string;
  name: string;
  share_bps: number;
  held_account_id: string;
  available_account_id: string;
  bank_account_number: string;
}

export interface TicketType {
  id: string;
  event_id: string;
  name: string;
  price_cents: number;
  capacity: number;
}

const EVENT_COLUMNS =
  "id, name, venue, currency, starts_at, ends_at, fee_bps, fee_fixed_cents, hold_hours, advance_bps, status, " +
  "cancelled_at, cancel_reason, released_at, created_at";
const ORGANIZER_COLUMNS = "id, name, currency, bank_account_number, held_account_id, available_account_id, created_at";

/** An organizer and their two ledger accounts, in one transaction. */
export async function createOrganizer(
  pool: pg.Pool,
  input: { name: string; currency: string; bank_account_number: string },
): Promise<Organizer> {
  return withTransaction(pool, async (c) => {
    const { rows: accounts } = await c.query<{ id: string; kind: string }>(
      `INSERT INTO accounts (name, currency, kind)
       VALUES ($1, $3, 'organizer_held'), ($2, $3, 'organizer')
       RETURNING id, kind`,
      [`${input.name}: held until events happen`, `${input.name}: available`, input.currency],
    );
    const held = accounts.find((a) => a.kind === "organizer_held")!.id;
    const available = accounts.find((a) => a.kind === "organizer")!.id;
    const { rows } = await c.query<Organizer>(
      `INSERT INTO organizers (name, currency, bank_account_number, held_account_id, available_account_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${ORGANIZER_COLUMNS}`,
      [input.name, input.currency, input.bank_account_number, held, available],
    );
    return rows[0];
  });
}

export async function getOrganizer(db: pg.Pool | pg.PoolClient, id: string): Promise<Organizer | undefined> {
  const { rows } = await db.query<Organizer>(`SELECT ${ORGANIZER_COLUMNS} FROM organizers WHERE id = $1`, [id]);
  return rows[0];
}

export interface CreateEventInput {
  name: string;
  venue?: string;
  currency: string;
  starts_at: string;
  ends_at: string;
  fee_bps?: number;
  fee_fixed_cents?: number;
  hold_hours?: number;
  advance_bps?: number;
  organizers: { organizer_id: string; share_bps: number }[];
  ticket_types: { name: string; price_cents: number; capacity: number }[];
}

/** An event, who hosts it (shares adding up to 100%), and its ticket types, in one transaction. */
export async function createEvent(pool: pg.Pool, input: CreateEventInput): Promise<EventRow> {
  const total = input.organizers.reduce((sum, o) => sum + o.share_bps, 0);
  if (total !== 10_000) throw new ApiError(422, "shares_must_total_100", `Organizer shares add up to ${total / 100}%, not 100%.`);
  if (new Set(input.organizers.map((o) => o.organizer_id)).size !== input.organizers.length) {
    throw new ApiError(422, "duplicate_organizer", "Each organizer can appear once.");
  }
  if (new Date(input.ends_at) < new Date(input.starts_at)) throw new ApiError(422, "invalid_dates", "ends_at is before starts_at.");
  return withTransaction(pool, async (c) => {
    const { rows: orgs } = await c.query<{ id: string; currency: string }>(
      "SELECT id, currency FROM organizers WHERE id = ANY($1::uuid[])",
      [input.organizers.map((o) => o.organizer_id)],
    );
    if (orgs.length !== input.organizers.length) throw new ApiError(404, "organizer_not_found", "An organizer does not exist.");
    if (orgs.some((o) => o.currency !== input.currency)) {
      throw new ApiError(422, "currency_mismatch", "Every organizer must be paid in the event's currency.");
    }
    const { rows } = await c.query<EventRow>(
      `INSERT INTO events (name, venue, currency, starts_at, ends_at, fee_bps, fee_fixed_cents, hold_hours, advance_bps)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 500), COALESCE($7, 50), COALESCE($8, 48), COALESCE($9, 0))
       RETURNING ${EVENT_COLUMNS}`,
      [
        input.name,
        input.venue ?? "",
        input.currency,
        input.starts_at,
        input.ends_at,
        input.fee_bps ?? null,
        input.fee_fixed_cents ?? null,
        input.hold_hours ?? null,
        input.advance_bps ?? null,
      ],
    );
    const event = rows[0];
    for (const o of input.organizers) {
      await c.query("INSERT INTO event_organizers (event_id, organizer_id, share_bps) VALUES ($1, $2, $3)", [
        event.id,
        o.organizer_id,
        o.share_bps,
      ]);
    }
    for (const t of input.ticket_types) {
      await c.query("INSERT INTO ticket_types (event_id, name, price_cents, capacity) VALUES ($1, $2, $3, $4)", [
        event.id,
        t.name,
        t.price_cents,
        t.capacity,
      ]);
    }
    return event;
  });
}

export async function getEvent(db: pg.Pool | pg.PoolClient, id: string): Promise<EventRow | undefined> {
  const { rows } = await db.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Lock an event for a change to its money. Every operation that reads or
 * changes the proceeds held for an event (a sale, a refund, a dispute, a
 * release, an advance, a cancellation) takes this lock first, then any order
 * row, then (inside createTransferInTx) account rows. One order everywhere,
 * so they cannot deadlock, and "how much is held for this event" cannot
 * change between reading it and acting on it.
 */
export async function lockEvent(c: pg.PoolClient, id: string): Promise<EventRow> {
  const { rows } = await c.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new ApiError(404, "event_not_found", "Event not found.");
  return rows[0];
}

/** The event's organizers, lead (largest share) first. */
export async function eventOrganizers(db: pg.Pool | pg.PoolClient, eventId: string): Promise<EventOrganizer[]> {
  const { rows } = await db.query<EventOrganizer>(
    `SELECT eo.organizer_id, o.name, eo.share_bps, o.held_account_id, o.available_account_id, o.bank_account_number
       FROM event_organizers eo JOIN organizers o ON o.id = eo.organizer_id
      WHERE eo.event_id = $1
      ORDER BY eo.share_bps DESC, eo.organizer_id`,
    [eventId],
  );
  return rows;
}

export async function ticketTypes(db: pg.Pool | pg.PoolClient, eventId: string): Promise<(TicketType & { sold: number })[]> {
  const { rows } = await db.query<TicketType & { sold: number }>(
    `SELECT tt.id, tt.event_id, tt.name, tt.price_cents, tt.capacity,
            (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status IN ('reserved', 'valid'))::int AS sold
       FROM ticket_types tt WHERE tt.event_id = $1 ORDER BY tt.price_cents, tt.name`,
    [eventId],
  );
  return rows;
}

/** When an event's held proceeds become due for release. */
export const releaseDueAt = (e: Pick<EventRow, "ends_at" | "hold_hours">) => new Date(e.ends_at.getTime() + e.hold_hours * 3_600_000);

/**
 * What is held for this event for this organizer right now: the sum of the
 * entries on their held account that belong to the event. Read it under the
 * event lock.
 */
export async function heldForEvent(c: pg.PoolClient, org: Pick<EventOrganizer, "organizer_id" | "held_account_id">, eventId: string) {
  const { rows } = await c.query<{ held: number }>(
    `SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS held
       FROM ledger_entries e JOIN organizer_postings p ON p.transfer_id = e.transfer_id
      WHERE e.account_id = $1 AND p.organizer_id = $2 AND p.event_id = $3`,
    [org.held_account_id, org.organizer_id, eventId],
  );
  return rows[0].held;
}

/**
 * Post one system transfer that touches an organizer's money, with the posting
 * row that explains it. Throws if the ledger refuses it (e.g. not enough held),
 * which rolls back the caller's whole transaction: callers compute amounts so
 * that this cannot happen, so if it does, it is a bug, and nothing half-done
 * is left behind.
 */
export async function postForOrganizer(
  c: pg.PoolClient,
  key: string,
  move: { from: string; to: string; amount: number; currency: string },
  posting: { organizerId: string; kind: PostingKind; memo: string; ctx: PostingContext },
): Promise<string | null> {
  if (move.amount === 0) return null;
  if (move.amount < 0) throw new Error(`negative amount for ${key}`);
  const { transfer } = await createTransferInTx(
    c,
    key,
    { from_account_id: move.from, to_account_id: move.to, amount_cents: move.amount, currency: move.currency },
    { scope: "system" },
  );
  if (transfer.status !== "posted") throw new Error(`ledger refused ${key}: ${transfer.failure_reason}`);
  await recordOrganizerPosting(c, transfer.id, posting.organizerId, posting.kind, posting.memo, posting.ctx);
  return transfer.id;
}

/**
 * Take `amount` from an organizer for something that happened at an event (a
 * refund, a chargeback): from what is still held for the event first, and the
 * rest from their available balance, which may go negative. Negative means the
 * event's money was already released or advanced to them, and they now owe it.
 */
export async function debitOrganizer(
  c: pg.PoolClient,
  keyBase: string,
  org: EventOrganizer,
  eventId: string,
  amount: number,
  to: string,
  currency: string,
  posting: { kind: PostingKind; memo: string; ctx: PostingContext },
): Promise<{ fromHeld: number; fromAvailable: number }> {
  const held = Math.max(0, await heldForEvent(c, org, eventId));
  const fromHeld = Math.min(held, amount);
  const fromAvailable = amount - fromHeld;
  const p = { organizerId: org.organizer_id, ...posting, ctx: { eventId, ...posting.ctx } };
  await postForOrganizer(c, `${keyBase}:held`, { from: org.held_account_id, to, amount: fromHeld, currency }, p);
  await postForOrganizer(
    c,
    `${keyBase}:available`,
    { from: org.available_account_id, to, amount: fromAvailable, currency },
    p,
  );
  return { fromHeld, fromAvailable };
}

/** Where money owed to an organizer for an event goes: held until the event is released, available after. */
export const creditBucket = (event: Pick<EventRow, "released_at">, org: EventOrganizer) =>
  event.released_at ? org.available_account_id : org.held_account_id;
