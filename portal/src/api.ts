// A thin client for the box office (/box-office, public) and the organizer
// API (/organizer). The organizer's demo session lives in sessionStorage, so
// each tab can be a different organizer and closing it signs out.

export interface Session {
  token: string;
  organizer: { id: string; name: string };
}

const KEY = "portal-organizer-session";

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
  ) {
    super(message);
  }
}

export async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { session?: Session | null; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(opts.session ? { authorization: `Bearer ${opts.session.token}` } : {}),
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? "error", json.error?.message ?? `HTTP ${res.status}`);
  return json as T;
}

export const money = (cents: number, currency = "USD") => {
  const abs = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? "−" : ""}${currency === "USD" ? "$" : `${currency} `}${abs}`;
};

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---- shapes the API returns ---------------------------------------------------

export interface BoxOfficeEvent {
  id: string;
  name: string;
  venue: string;
  currency: string;
  starts_at: string;
  ends_at: string;
  organizers: string[];
  ticket_types: { id: string; name: string; price_cents: number; capacity: number; left: number }[];
}

export interface PublicOrder {
  id: string;
  status: string;
  amount_cents: number;
  currency: string;
  buyer_name: string;
  event: { id: string; name: string; starts_at: string; status: string; cancel_reason: string | null };
  tickets: { id: string; type: string; price_cents: number; status: string; refunded_cents: number }[];
  refunds: { amount_cents: number; status: string; reason: string; created_at: string }[];
}

export interface StatementItem {
  transfer_id: string;
  amount_cents: number;
  memo: string;
  bucket: "held" | "available";
  order_id: string | null;
  refund_id: string | null;
  dispute_id: string | null;
  adjustment_id: string | null;
  buyer_name: string | null;
  tickets: number | null;
  created_at: string;
}

export interface StatementLine {
  kind: string;
  label: string;
  amount_cents: number;
  count: number;
  items: StatementItem[];
}

export interface StatementSection {
  event: { id: string; name: string; starts_at: string; status: string; share_bps: number } | null;
  title: string;
  lines: StatementLine[];
  total_cents: number;
}

export interface PayoutStatement {
  payout: { id: string; amount_cents: number; currency: string; status: string; failure_reason: string | null; created_at: string; updated_at: string } | null;
  opening_balance_cents: number;
  sections: StatementSection[];
  total_cents: number;
  balanced: boolean;
  summary: string[];
}

export interface Overview {
  organizer: { id: string; name: string; currency: string; bank_account_last4: string };
  balances: { held_cents: number; available_cents: number; in_flight_cents: number; owed_by_organizer_cents: number };
  upcoming: PayoutStatement;
  held: { event: StatementSection["event"] & { release_due_at: string; advance_bps: number }; held_cents: number; section: StatementSection }[];
  payouts: PayoutStatement[];
}

export interface OrganizerEvent {
  id: string;
  name: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  status: "on_sale" | "cancelled";
  cancel_reason: string | null;
  released_at: string | null;
  release_due_at: string;
  advance_bps: number;
  share_bps: number;
  tickets_sold: number;
  gross_cents: number;
  refunded_cents: number;
  orders: number;
  co_hosts: string[];
}

export interface EventDetail {
  event: OrganizerEvent;
  organizers: { organizer_id: string; name: string; share_bps: number }[];
  orders: {
    id: string;
    buyer_name: string;
    buyer_email: string;
    amount_cents: number;
    currency: string;
    status: string;
    created_at: string;
    refunded_cents: number;
    disputed_cents: number;
    tickets: { id: string; type: string; price_cents: number; status: string; refunded_cents: number }[];
  }[];
}

export interface OrderTrace {
  order: { id: string; event_name: string; buyer_name: string; buyer_email: string; amount_cents: number; fee_cents: number; currency: string; status: string; stripe_checkout_session_id: string | null; stripe_payment_intent_id: string | null; created_at: string; paid_at: string | null };
  tickets: { id: string; type: string; price_cents: number; fee_cents: number; status: string; refunded_cents: number }[];
  refunds: { id: string; amount_cents: number; reason: string; note: string | null; requested_by: string; status: string; stripe_refund_id: string | null; created_at: string }[];
  disputes: { id: string; stripe_dispute_id: string; amount_cents: number; fee_cents: number; reason: string; status: string; created_at: string }[];
  transfers: { id: string; idempotency_key: string; amount_cents: number; created_at: string; kind: string | null; memo: string | null; entries: { account: string; amount_cents: number }[] }[];
}
