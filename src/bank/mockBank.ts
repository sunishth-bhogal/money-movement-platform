import { randomUUID } from "node:crypto";
import {
  BankConflictError,
  BankRejectedError,
  BankUnavailableError,
  type BankClient,
  type BankListPage,
  type BankPayout,
  type BankPayoutRequest,
  type BankPayoutStatus,
} from "./client.js";

/**
 * A fake bank that misbehaves on purpose. It is the remote system: it keeps
 * its own records, which our database cannot see or change, and it only
 * tells us things through API responses and webhooks.
 *
 * What a payout does is decided by the destination account number, like
 * Stripe's test card numbers:
 *
 *   ...0002  accepted, then fails after the settlement delay (account_closed)
 *   ...0004  refused synchronously with 422 (invalid_account_number)
 *   ...0005  succeeds, then is returned by the receiving bank (account_frozen)
 *   anything else: accepted, then succeeds after the settlement delay
 *
 * Network trouble is set with `behaviour`, at any time (see MockBankBehaviour).
 */
export interface MockBankBehaviour {
  /** Every API call fails with "503" and the bank records nothing. */
  outage: boolean;
  /**
   * The next N createPayout calls are processed and recorded by the bank, and
   * then the response is lost on the way back: the caller sees a timeout.
   */
  loseResponses: number;
  /** Delay before answering an API call. */
  latencyMs: number;
  /** How long after acceptance a payout reaches its final status ("delayed success"). */
  settleAfterMs: number;
  /** How long after success a ...0005 payout is returned. */
  returnAfterMs: number;
  /** Deliveries per webhook event. 1 is normal, more simulates duplicate webhooks. */
  webhookCopies: number;
  /** false: the bank never sends webhooks (misconfigured endpoint, lost events). */
  webhooksEnabled: boolean;
}

export interface BankWebhookEvent {
  id: string;
  type: `payout.${Exclude<BankPayoutStatus, "processing">}`;
  created_at: string;
  data: BankPayout;
}

export interface MockBankOptions {
  behaviour?: Partial<MockBankBehaviour>;
  /** Sends one webhook delivery. Throw (or reject) if the receiver did not accept it; the bank retries later. */
  deliver?: (event: BankWebhookEvent) => Promise<void>;
  /** Injectable clock, so tests can move time forward. */
  now?: () => number;
}

interface StoredPayout {
  payout: BankPayout;
  /** Fingerprint of the request, to detect a key reused with a different body. */
  fingerprint: string;
  settleAt: number;
  returnAt?: number;
  /** For a synchronous rejection: replayed on every retry with the same key. */
  rejection?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new BankUnavailableError("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new BankUnavailableError("request aborted (timeout)"));
    });
  });

export class MockBank implements BankClient {
  readonly behaviour: MockBankBehaviour;
  private readonly byKey = new Map<string, StoredPayout>();
  private readonly deliver?: (event: BankWebhookEvent) => Promise<void>;
  private readonly now: () => number;
  /** Webhook deliveries not yet accepted by the receiver. */
  private queue: BankWebhookEvent[] = [];
  /** Every webhook delivery attempted, accepted or not. For tests and demos. */
  readonly deliveryLog: { eventId: string; type: string; ok: boolean }[] = [];
  /** Every createPayout call that reached the bank, including replays. */
  createCalls = 0;

  constructor(opts: MockBankOptions = {}) {
    this.behaviour = {
      outage: false,
      loseResponses: 0,
      latencyMs: 0,
      settleAfterMs: 1_000,
      returnAfterMs: 1_000,
      webhookCopies: 1,
      webhooksEnabled: true,
      ...opts.behaviour,
    };
    this.deliver = opts.deliver;
    this.now = opts.now ?? Date.now;
  }

  // ---- the API ----------------------------------------------------------------

  async createPayout(req: BankPayoutRequest, signal?: AbortSignal): Promise<BankPayout> {
    await this.enter(signal);
    this.createCalls++;
    const fingerprint = JSON.stringify([req.reference, req.amount_cents, req.currency, req.account_number]);
    let stored = this.byKey.get(req.idempotency_key);
    if (stored && stored.fingerprint !== fingerprint) {
      throw new BankConflictError("idempotency key reused with a different request");
    }
    if (!stored) {
      const rejection = req.account_number.endsWith("0004") ? "invalid_account_number" : undefined;
      stored = {
        fingerprint,
        settleAt: this.now() + this.behaviour.settleAfterMs,
        rejection,
        payout: {
          id: `po_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
          idempotency_key: req.idempotency_key,
          reference: req.reference,
          amount_cents: req.amount_cents,
          currency: req.currency,
          account_number: req.account_number,
          status: rejection ? "failed" : "processing",
          failure_code: rejection ?? null,
          created_at: new Date(this.now()).toISOString(),
        },
      };
      this.byKey.set(req.idempotency_key, stored);
    }
    // The bank has done its work. Now the response may still be lost.
    if (this.behaviour.loseResponses > 0) {
      this.behaviour.loseResponses--;
      throw new BankUnavailableError("timed out waiting for the bank's response");
    }
    if (stored.rejection) throw new BankRejectedError(stored.rejection, { ...stored.payout });
    return { ...stored.payout };
  }

  async getPayoutByKey(key: string, signal?: AbortSignal): Promise<BankPayout | null> {
    await this.enter(signal);
    const stored = this.byKey.get(key);
    return stored ? { ...stored.payout } : null;
  }

  async listPayouts(page: BankListPage, signal?: AbortSignal): Promise<{ data: BankPayout[]; has_more: boolean }> {
    await this.enter(signal);
    const all = [...this.byKey.values()].map((s) => s.payout);
    const start = page.starting_after ? all.findIndex((p) => p.id === page.starting_after) + 1 : 0;
    const limit = page.limit ?? 100;
    return { data: all.slice(start, start + limit).map((p) => ({ ...p })), has_more: start + limit < all.length };
  }

  private async enter(signal?: AbortSignal) {
    if (this.behaviour.latencyMs > 0) await sleep(this.behaviour.latencyMs, signal);
    if (this.behaviour.outage) throw new BankUnavailableError("bank answered HTTP 503");
  }

  // ---- the bank's own processing ----------------------------------------------

  /**
   * Move payouts whose time has come to their next status, and (re)try
   * webhook deliveries. The server calls this on a timer; tests call it after
   * moving the clock.
   */
  async processDue(): Promise<void> {
    const now = this.now();
    for (const s of this.byKey.values()) {
      const p = s.payout;
      if (p.status === "processing" && s.settleAt <= now) {
        if (p.account_number.endsWith("0002")) {
          this.transition(s, "failed", "account_closed");
        } else {
          this.transition(s, "succeeded");
          if (p.account_number.endsWith("0005")) s.returnAt = now + this.behaviour.returnAfterMs;
        }
      } else if (p.status === "succeeded" && s.returnAt !== undefined && s.returnAt <= now) {
        this.transition(s, "returned", "account_frozen");
      }
    }
    await this.flushWebhooks();
  }

  private transition(s: StoredPayout, status: Exclude<BankPayoutStatus, "processing">, failureCode?: string) {
    s.payout.status = status;
    s.payout.failure_code = failureCode ?? null;
    this.emit(s.payout, `payout.${status}`);
  }

  /** Queue a webhook event about this payout. Public so tests can make the bank say odd things. */
  emit(payout: BankPayout, type: BankWebhookEvent["type"], eventId = `evt_${randomUUID().replaceAll("-", "").slice(0, 24)}`) {
    if (!this.behaviour.webhooksEnabled) return;
    const event: BankWebhookEvent = { id: eventId, type, created_at: new Date(this.now()).toISOString(), data: { ...payout } };
    for (let i = 0; i < this.behaviour.webhookCopies; i++) this.queue.push(event);
  }

  /** Try every queued delivery once. Failed ones stay queued for the next call. */
  async flushWebhooks(): Promise<void> {
    if (!this.deliver) return;
    const batch = this.queue;
    this.queue = [];
    for (const event of batch) {
      try {
        await this.deliver(event);
        this.deliveryLog.push({ eventId: event.id, type: event.type, ok: true });
      } catch {
        this.deliveryLog.push({ eventId: event.id, type: event.type, ok: false });
        this.queue.push(event);
      }
    }
  }

  // ---- inspection (the bank's "dashboard") ------------------------------------

  /** Every payout the bank holds, as the bank sees it. */
  payouts(): BankPayout[] {
    return [...this.byKey.values()].map((s) => ({ ...s.payout }));
  }

  /** Change a payout's record directly, e.g. to make the bank disagree with us. */
  tamper(key: string, change: Partial<BankPayout>): void {
    const s = this.byKey.get(key);
    if (!s) throw new Error(`no payout for key ${key}`);
    Object.assign(s.payout, change);
  }

  /** Put a payout on the bank's books that we never asked for (a bank error, or fraud). */
  inject(payout: Omit<BankPayout, "id" | "created_at"> & { id?: string }): BankPayout {
    const stored: StoredPayout = {
      fingerprint: "injected",
      settleAt: this.now(),
      payout: {
        ...payout,
        id: payout.id ?? `po_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        created_at: new Date(this.now()).toISOString(),
      },
    };
    this.byKey.set(payout.idempotency_key, stored);
    return { ...stored.payout };
  }

  /** The bank loses its record of a payout (e.g. a restart of the in-memory mock). */
  forget(key: string): void {
    this.byKey.delete(key);
  }

  knows(key: string): boolean {
    return this.byKey.has(key);
  }

  pendingWebhooks(): number {
    return this.queue.length;
  }
}
