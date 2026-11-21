// The bank, as our code sees it: two calls, and the errors that tell us how to
// react. The mock bank implements this in-process (tests), and httpBankClient
// implements it over HTTP against the mock bank server (npm run mock-bank).

/** The bank's view of a payout. */
export type BankPayoutStatus = "processing" | "succeeded" | "failed" | "returned";

export interface BankPayout {
  /** The bank's id for the payout. */
  id: string;
  /** The key we sent. The bank keeps one payout per key. */
  idempotency_key: string;
  /** Our payout id, echoed back in webhooks and lookups. */
  reference: string;
  amount_cents: number;
  currency: string;
  account_number: string;
  status: BankPayoutStatus;
  failure_code: string | null;
  created_at: string;
}

export interface BankPayoutRequest {
  idempotency_key: string;
  reference: string;
  amount_cents: number;
  currency: string;
  account_number: string;
}

/**
 * The bank definitively refused the payout (e.g. the account number is
 * invalid). The same request will always be refused, and the bank holds no
 * money for it, so it is safe to treat as failed.
 */
export class BankRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly payout?: BankPayout,
  ) {
    super(`bank rejected the payout: ${code}`);
  }
}

/**
 * We reused an idempotency key with a different body. That is a bug on our
 * side, never something a retry can fix.
 */
export class BankConflictError extends Error {}

/**
 * The bank could not be reached, timed out, or answered 5xx/429. The outcome
 * is UNKNOWN: the bank may or may not have acted on the request. Never treat
 * this as a failure. Retry with the same idempotency key, or look it up.
 */
export class BankUnavailableError extends Error {}

export interface BankClient {
  /**
   * Ask the bank to pay out. Idempotent on `idempotency_key`: sending the
   * same request again returns the payout the bank already has.
   */
  createPayout(req: BankPayoutRequest, signal?: AbortSignal): Promise<BankPayout>;
  /** The bank's current record for a key, or null if it has never seen it. */
  getPayoutByKey(idempotencyKey: string, signal?: AbortSignal): Promise<BankPayout | null>;
}

/** Talks to the mock bank server over HTTP. */
export function httpBankClient(baseUrl: string, fetchImpl: typeof fetch = fetch): BankClient {
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(`${baseUrl}${path}`, init);
    } catch (err) {
      // Connection refused, reset, DNS, or our own timeout firing: unknown outcome.
      throw new BankUnavailableError(`bank unreachable: ${(err as Error).message}`);
    }
  };
  const unavailable = (res: Response) => res.status >= 500 || res.status === 429 || res.status === 408;

  return {
    async createPayout(req, signal) {
      const res = await call("/payouts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": req.idempotency_key },
        body: JSON.stringify({
          reference: req.reference,
          amount_cents: req.amount_cents,
          currency: req.currency,
          account_number: req.account_number,
        }),
        signal,
      });
      if (res.ok) return (await res.json()) as BankPayout;
      if (unavailable(res)) throw new BankUnavailableError(`bank answered HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string }; payout?: BankPayout };
      if (res.status === 409) throw new BankConflictError(`bank answered 409: ${body.error?.code ?? "conflict"}`);
      throw new BankRejectedError(body.error?.code ?? `http_${res.status}`, body.payout);
    },

    async getPayoutByKey(key, signal) {
      const res = await call(`/payouts?idempotency_key=${encodeURIComponent(key)}`, { signal });
      if (res.status === 404) return null;
      if (res.ok) return (await res.json()) as BankPayout;
      throw new BankUnavailableError(`bank answered HTTP ${res.status}`);
    },
  };
}
