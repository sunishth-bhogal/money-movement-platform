import type pg from "pg";

/**
 * Why a ledger transfer touched an organizer's money. One row per transfer,
 * written in the same transaction as the transfer: the database refuses to
 * commit an entry on an organizer account without one (see 007_events.sql).
 *
 * This module only writes rows, so the payout code can call it without
 * depending on the events code.
 */
export type PostingKind =
  | "ticket_sale"
  | "platform_fee"
  | "refund"
  | "fee_returned"
  | "dispute"
  | "dispute_fee"
  | "dispute_won"
  | "release"
  | "advance"
  | "payout"
  | "payout_failed"
  | "payout_returned"
  | "adjustment"
  | "reconciliation";

export interface PostingContext {
  eventId?: string | null;
  orderId?: string | null;
  ticketId?: string | null;
  refundId?: string | null;
  disputeId?: string | null;
  payoutId?: string | null;
  adjustmentId?: string | null;
  resolutionId?: string | null;
}

export async function recordOrganizerPosting(
  client: pg.PoolClient,
  transferId: string,
  organizerId: string,
  kind: PostingKind,
  memo: string,
  ctx: PostingContext = {},
): Promise<void> {
  await client.query(
    `INSERT INTO organizer_postings
       (transfer_id, organizer_id, kind, event_id, order_id, ticket_id, refund_id, dispute_id, payout_id, adjustment_id, resolution_id, memo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (transfer_id) DO NOTHING`,
    [
      transferId,
      organizerId,
      kind,
      ctx.eventId ?? null,
      ctx.orderId ?? null,
      ctx.ticketId ?? null,
      ctx.refundId ?? null,
      ctx.disputeId ?? null,
      ctx.payoutId ?? null,
      ctx.adjustmentId ?? null,
      ctx.resolutionId ?? null,
      memo,
    ],
  );
}

/** The organizer whose held or available account this is, if any. */
export async function organizerOfAccount(
  client: pg.PoolClient,
  accountId: string,
): Promise<{ id: string; bucket: "held" | "available" } | undefined> {
  const { rows } = await client.query<{ id: string; bucket: "held" | "available" }>(
    `SELECT id, CASE WHEN held_account_id = $1 THEN 'held' ELSE 'available' END AS bucket
       FROM organizers WHERE held_account_id = $1 OR available_account_id = $1`,
    [accountId],
  );
  return rows[0];
}
