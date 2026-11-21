// A thin client for the wallet API (/me). The demo session lives in
// sessionStorage only, so each browser tab can be signed in as a different
// user (Alice in one, Bob in another) and closing the tab signs out.

export interface Session {
  token: string;
  account: { id: string; name: string; currency: string };
}

const KEY = "wallet-session";

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: the session lasts until reload
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

/** The request may or may not have happened (network error, 5xx). Retrying with the same key is safe. */
export function isUnknownOutcome(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500;
}

export interface Response<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export async function request<T>(
  session: Session | null,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<Response<T>> {
  let res: globalThis.Response;
  try {
    res = await fetch(`/me${path}`, {
      method,
      headers: {
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new ApiError(0, "network_error", `No answer from the server (${(err as Error).message}).`);
  }
  const json = await res.json().catch(() => ({}));
  const replayed = res.headers.get("idempotent-replayed") === "true";
  // A 422 with an item is a recorded outcome (e.g. not enough money), not a failed request.
  if (res.status === 422 && (json as { item?: unknown }).item) return { status: res.status, body: json as T, replayed };
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText, json);
  }
  return { status: res.status, body: json as T, replayed };
}

export const get = <T>(session: Session | null, path: string) => request<T>(session, "GET", path).then((r) => r.body);

// ---- shapes the API returns ---------------------------------------------------

export interface Config {
  sign_in: "demo";
  deposits: "stripe_test" | "demo_checkout" | "disabled";
  bank_controls: boolean;
}

export interface DemoUser {
  id: string;
  name: string;
  currency: string;
  balance_cents: number;
}

export interface Balances {
  account: Session["account"];
  available_cents: number;
  on_hold_cents: number;
  incoming_cents: number;
}

export type ActivityState = "pending" | "settled" | "failed";

export interface ActivityItem {
  id: string;
  kind: "deposit" | "payout" | "transfer_in" | "transfer_out" | "adjustment";
  object_id: string;
  title: string;
  state: ActivityState;
  status: string;
  status_label: string;
  amount_cents: number;
  balance_effect_cents: number;
  currency: string;
  counterparty: { id: string; name: string } | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatementLine {
  entry_id: number;
  transfer_id: string;
  description: string;
  activity_id: string;
  amount_cents: number;
  balance_after_cents: number;
  currency: string;
  created_at: string;
}

export interface WriteResult {
  item: ActivityItem;
  replayed: boolean;
  checkout_url?: string | null;
  error?: { code: string; message: string };
}

export interface BankBehaviour {
  outage: boolean;
  loseResponses: number;
  webhookCopies: number;
  webhooksEnabled: boolean;
}

export const money = (cents: number, currency = "USD", opts: { sign?: boolean } = {}) => {
  const abs = (Math.abs(cents) / 100).toLocaleString(undefined, { style: "currency", currency });
  if (cents < 0) return `−${abs}`;
  return opts.sign && cents > 0 ? `+${abs}` : abs;
};

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
