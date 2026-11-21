import { PermanentPublishError, type Publisher } from "./worker.js";

/** The JSON body every destination receives. `id` is the dedup key. */
export function envelope(event: {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
}) {
  return {
    id: event.event_id,
    type: event.event_type,
    aggregate: { type: event.aggregate_type, id: event.aggregate_id },
    data: event.payload,
    created_at: event.created_at.toISOString(),
  };
}

/**
 * POST each event as JSON to a URL. The event id is sent as `Idempotency-Key`
 * so the receiver can drop redeliveries.
 *
 * 2xx: delivered. 408, 429 and 5xx: retried with backoff. Other 4xx: the
 * receiver is telling us the request itself is wrong, so retrying cannot help
 * and the event goes to `dead` for a person to look at.
 */
export function httpPublisher(url: string, fetchImpl: typeof fetch = fetch): Publisher {
  return {
    async publish(event, signal) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": event.event_id,
          "x-event-type": event.event_type,
        },
        body: JSON.stringify(envelope(event)),
        signal,
      });
      if (res.ok) return;
      const detail = `HTTP ${res.status} from ${url}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new PermanentPublishError(detail);
      }
      throw new Error(detail);
    },
  };
}

/** Writes events to stdout. The default when no destination is configured. */
export function logPublisher(write: (line: string) => void = (l) => console.log(l)): Publisher {
  return {
    async publish(event) {
      write(JSON.stringify({ outbox: envelope(event), attempt: event.attempts }));
    },
  };
}

/**
 * Sends each event to the publisher registered for its type, and everything
 * else to `fallback`. This is how one outbox carries both announcements
 * ("transfer.posted", for downstream consumers) and commands to providers
 * ("payout.submit", for the bank connector), with the same retry machinery.
 */
export function routingPublisher(routes: Record<string, Publisher>, fallback: Publisher): Publisher {
  return {
    publish(event, signal) {
      return (routes[event.event_type] ?? fallback).publish(event, signal);
    },
  };
}
