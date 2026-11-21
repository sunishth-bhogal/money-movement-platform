import type pg from "pg";

export interface InboundEvent {
  provider: string;
  eventId: string;
  type: string;
  payload: unknown;
}

/**
 * Record an external event (e.g. a webhook) and report whether this is the
 * first time we have seen it. Call it INSIDE the same transaction that applies
 * the event's effects: if those effects roll back, so does the record, and a
 * redelivery will be processed again. If it returns false, skip the effects.
 */
export async function recordEventOnce(client: pg.PoolClient, event: InboundEvent): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO processed_events (provider, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [event.provider, event.eventId, event.type, JSON.stringify(event.payload)],
  );
  return rowCount === 1;
}
