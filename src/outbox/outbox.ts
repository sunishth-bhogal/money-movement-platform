import type pg from "pg";

export interface NewOutboxEvent {
  eventType: string;
  aggregateType: "transfer" | "deposit" | "payout" | "reconciliation";
  aggregateId: string;
  payload: unknown;
}

export interface OutboxEvent {
  id: number;
  /** Stable across retries and redeliveries. Consumers deduplicate on this. */
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  /** Including the current one. */
  attempts: number;
  created_at: Date;
}

/**
 * Record an event to be published after commit.
 *
 * Call it with the client of the transaction that makes the change the event
 * describes, never with the pool. That is the whole point of an outbox: the
 * event row commits if and only if the change commits, so there is no window
 * in which one exists without the other.
 */
export async function enqueueOutboxEvent(client: pg.PoolClient, event: NewOutboxEvent): Promise<string> {
  const { rows } = await client.query<{ event_id: string }>(
    `INSERT INTO outbox (event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING event_id`,
    [event.eventType, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
  );
  return rows[0].event_id;
}

/** Put a dead event back in the queue with a fresh attempt budget (an operator action). */
export async function requeueDeadEvent(pool: pg.Pool, eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbox
        SET status = 'pending', attempts = 0, next_attempt_at = now(), claim_token = NULL
      WHERE event_id = $1 AND status = 'dead'`,
    [eventId],
  );
  return rowCount === 1;
}
