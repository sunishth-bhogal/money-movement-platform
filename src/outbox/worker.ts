import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { OutboxEvent } from "./outbox.js";

/**
 * Where events go: a message broker, a partner's webhook, a notification
 * service. Resolve once the destination has durably accepted the event; throw
 * otherwise. Honour `signal`: it fires when the publish timeout runs out.
 */
export interface Publisher {
  publish(event: OutboxEvent, signal: AbortSignal): Promise<void>;
}

/** Throw this from a publisher when retrying cannot help (e.g. HTTP 400). The event goes straight to `dead`. */
export class PermanentPublishError extends Error {}

export interface WorkerOptions {
  /** Shows up in logs only. Correctness never depends on it. */
  workerId?: string;
  /** Rows claimed per poll. They are published in parallel. */
  batchSize?: number;
  /**
   * How long a claim is exclusive. If the worker dies, another worker can take
   * the row once this runs out. Must exceed publishTimeoutMs, so a live worker
   * never loses a row it is still publishing.
   */
  leaseMs?: number;
  publishTimeoutMs?: number;
  /** Total publish attempts, including the first, before an event is `dead`. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Sleep between polls when there was nothing to do. */
  pollIntervalMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  onError?: (err: unknown) => void;
}

export interface BatchResult {
  claimed: number;
  published: number;
  retried: number;
  dead: number;
  /** Completions rejected because our lease had expired and someone else took the row. */
  lostLease: number;
}

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half is
 * random. The fixed half guarantees a real pause before a retry, and the random
 * half spreads out a crowd of events that all failed at the same moment (say, a
 * downstream outage) so they don't all retry in lockstep.
 *
 *   attempt 1 failed → 0.5–1 × base, attempt 2 → 1–2 × base, attempt 3 → 2–4 × base, ... capped at maxDelayMs.
 */
export function backoffDelayMs(
  failedAttempts: number,
  { baseDelayMs, maxDelayMs }: { baseDelayMs: number; maxDelayMs: number },
  random: () => number = Math.random,
): number {
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failedAttempts - 1));
  return Math.round(window / 2 + random() * (window / 2));
}

/** A claimed batch: the rows, plus the token that proves we still hold them. */
export interface Claim {
  token: string;
  events: OutboxEvent[];
}

const EVENT_COLUMNS = "id, event_id, event_type, aggregate_type, aggregate_id, payload, attempts, created_at";

/**
 * Publishes outbox rows. Safe to run as many copies as you like, in one
 * process or many: they coordinate only through Postgres.
 *
 * One poll is three short, separate statements. No transaction is held open
 * while publishing, because a network call inside a transaction holds row
 * locks and a connection for as long as the slowest destination takes.
 *
 *  1. claim:    lock due rows with FOR UPDATE SKIP LOCKED (concurrent workers
 *               skip each other's rows instead of queueing behind them), bump
 *               attempts, set a fresh claim_token, and push next_attempt_at
 *               forward by the lease. Commit.
 *  2. publish:  outside any transaction, with a timeout.
 *  3. complete: mark published, or schedule a retry with backoff, or mark dead.
 *               Only if claim_token still matches (fencing).
 *
 * Crash between 1 and 3: the lease runs out and another worker re-publishes.
 * That is why delivery is at-least-once and consumers dedupe on event_id.
 */
export class OutboxWorker {
  readonly workerId: string;
  private readonly o: Required<Omit<WorkerOptions, "workerId" | "onError">> & Pick<WorkerOptions, "onError">;
  private running?: Promise<void>;
  private stopping = false;
  private wake?: () => void;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    opts: WorkerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.o = {
      batchSize: opts.batchSize ?? 20,
      leaseMs: opts.leaseMs ?? 60_000,
      publishTimeoutMs: opts.publishTimeoutMs ?? 10_000,
      maxAttempts: opts.maxAttempts ?? 10,
      baseDelayMs: opts.baseDelayMs ?? 1_000,
      maxDelayMs: opts.maxDelayMs ?? 10 * 60_000,
      pollIntervalMs: opts.pollIntervalMs ?? 1_000,
      random: opts.random ?? Math.random,
      onError: opts.onError,
    };
    if (this.o.publishTimeoutMs >= this.o.leaseMs) {
      throw new Error("publishTimeoutMs must be shorter than leaseMs, or a slow publish could be taken over while still running");
    }
    if (this.o.maxAttempts < 1) throw new Error("maxAttempts must be at least 1");
  }

  /**
   * Step 1. Also retires rows whose final attempt never reported back (the
   * worker crashed or hung on its last try), since claiming them again would
   * exceed maxAttempts.
   */
  async claim(): Promise<Claim> {
    await this.pool.query(
      `UPDATE outbox
          SET status = 'dead',
              claim_token = NULL,
              last_error = concat_ws('; ', last_error, 'lease expired on the final attempt (worker crashed or hung)')
        WHERE id IN (
          SELECT id FROM outbox
           WHERE status = 'pending' AND next_attempt_at <= now() AND attempts >= $1
             FOR UPDATE SKIP LOCKED)`,
      [this.o.maxAttempts],
    );

    const token = randomUUID();
    const { rows } = await this.pool.query<OutboxEvent>(
      `WITH due AS (
         SELECT id FROM outbox
          WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < $3
          ORDER BY next_attempt_at, id
          LIMIT $1
            FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o
          SET attempts = o.attempts + 1,
              claim_token = $2,
              next_attempt_at = now() + make_interval(secs => $4::double precision / 1000)
         FROM due
        WHERE o.id = due.id
       RETURNING ${EVENT_COLUMNS.split(", ").map((c) => `o.${c}`).join(", ")}`,
      [this.o.batchSize, token, this.o.maxAttempts, this.o.leaseMs],
    );
    rows.sort((a, b) => a.id - b.id);
    return { token, events: rows };
  }

  /** Step 3, success. Returns false if the lease was lost to another worker. */
  async markPublished(claim: Claim, event: OutboxEvent): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE outbox
          SET status = 'published', published_at = now(), claim_token = NULL
        WHERE id = $1 AND claim_token = $2 AND status = 'pending'`,
      [event.id, claim.token],
    );
    return rowCount === 1;
  }

  /** Step 3, failure. Schedules a retry, or retires the event. */
  async markFailed(claim: Claim, event: OutboxEvent, err: unknown): Promise<"retried" | "dead" | "lost_lease"> {
    const permanent = err instanceof PermanentPublishError;
    const dead = permanent || event.attempts >= this.o.maxAttempts;
    const delayMs = dead ? 0 : backoffDelayMs(event.attempts, this.o, this.o.random);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const { rowCount } = await this.pool.query(
      `UPDATE outbox
          SET status = CASE WHEN $3 THEN 'dead' ELSE 'pending' END,
              next_attempt_at = CASE WHEN $3 THEN next_attempt_at
                                     ELSE now() + make_interval(secs => $4::double precision / 1000) END,
              claim_token = NULL,
              last_error = $5
        WHERE id = $1 AND claim_token = $2 AND status = 'pending'`,
      [event.id, claim.token, dead, delayMs, `attempt ${event.attempts}: ${message}`],
    );
    if (rowCount !== 1) return "lost_lease";
    return dead ? "dead" : "retried";
  }

  /** Step 2. Rejects on timeout, even if the publisher ignores the signal. */
  private async publishWithTimeout(event: OutboxEvent): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`publish timed out after ${this.o.publishTimeoutMs}ms`));
      }, this.o.publishTimeoutMs);
    });
    try {
      await Promise.race([this.publisher.publish(event, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One poll: claim a batch, publish it, record the outcomes. */
  async runOnce(): Promise<BatchResult> {
    const claim = await this.claim();
    const result: BatchResult = { claimed: claim.events.length, published: 0, retried: 0, dead: 0, lostLease: 0 };
    await Promise.all(
      claim.events.map(async (event) => {
        let outcome: "published" | "retried" | "dead" | "lost_lease";
        try {
          await this.publishWithTimeout(event);
          outcome = (await this.markPublished(claim, event)) ? "published" : "lost_lease";
        } catch (err) {
          outcome = await this.markFailed(claim, event, err);
        }
        if (outcome === "lost_lease") result.lostLease++;
        else result[outcome]++;
      }),
    );
    return result;
  }

  /** Poll until there is nothing due right now. Handy for tests and one-shot runs. */
  async drain(): Promise<BatchResult> {
    const total: BatchResult = { claimed: 0, published: 0, retried: 0, dead: 0, lostLease: 0 };
    for (;;) {
      const r = await this.runOnce();
      for (const k of Object.keys(total) as (keyof BatchResult)[]) total[k] += r[k];
      if (r.claimed === 0) return total;
    }
  }

  /** Run in the background until stop(). */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = (async () => {
      while (!this.stopping) {
        let idle = true;
        try {
          idle = (await this.runOnce()).claimed === 0;
        } catch (err) {
          // e.g. the database is briefly unreachable. Nothing is lost: rows
          // stay pending and are claimed again on a later poll.
          this.o.onError?.(err);
        }
        if (idle && !this.stopping) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, this.o.pollIntervalMs);
            this.wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
        }
      }
    })();
  }

  /** Finish the in-flight batch, then stop. Claimed rows are always settled before this resolves. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
  }
}
