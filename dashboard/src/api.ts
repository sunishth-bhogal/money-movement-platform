// A thin client for the admin API. The token and the operator's name live in
// sessionStorage only: closing the tab signs out.

export interface Session {
  token: string;
  name: string;
}

const KEY = "recon-admin-session";

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

export async function api<T>(session: Session, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText);
  }
  return json as T;
}

// ---- shapes the API returns ---------------------------------------------------

export interface DimensionProof {
  ledger_cents: number;
  provider_cents: number;
  explained_cents: number;
  unattributed_cents: number;
  balanced: boolean;
}

export interface Run {
  id: string;
  source: "mock_bank" | "stripe";
  currency: string;
  status: "running" | "completed" | "failed";
  provider_records: number | null;
  matched: number | null;
  in_transit: number | null;
  auto_resolved: number | null;
  open_breaks: number | null;
  acknowledged: number | null;
  totals: Partial<Record<"held" | "settled", DimensionProof>> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ResolutionSummary {
  id: string;
  action: string;
  counterparty: string | null;
  cause: string | null;
  note: string;
  resolved_by: string;
  created_at: string;
}

export interface Break {
  id: string;
  run_id: string;
  source: Run["source"];
  break_key: string;
  object_type: "payout" | "deposit";
  object_id: string | null;
  account_id: string | null;
  provider_ref: string | null;
  classification: string;
  outcome: "open" | "auto_resolved" | "in_transit" | "acknowledged";
  currency: string;
  our_status: string | null;
  provider_status: string | null;
  ledger_held_cents: number;
  ledger_settled_cents: number;
  provider_held_cents: number;
  provider_settled_cents: number;
  auto_action: string | null;
  detail: string;
  created_at: string;
  resolution: ResolutionSummary | null;
}

export interface Summary {
  control_accounts: { id: string; name: string; system_code: string; currency: string; balance_cents: number }[];
  latest_runs: Run[];
  open_breaks: number;
  in_transit: number;
  flagged_payouts: number;
  stuck_payouts: number;
  dead_events: number;
  providers: { mock_bank: boolean; stripe: boolean };
}

export interface FlaggedPayout {
  id: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  provider_payout_id: string | null;
  discrepancy: string;
  updated_at: string;
  acknowledged: { note: string; resolved_by: string; created_at: string } | null;
}

export interface StuckPayout {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface DeadEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface Resolution extends ResolutionSummary {
  item_id: string | null;
  payout_id: string | null;
  break_key: string;
  transfer_ids: string[];
}

export interface Trace {
  break_key: string;
  transfers: {
    id: string;
    idempotency_key: string;
    amount_cents: number;
    currency: string;
    created_at: string;
    entries: { account_id: string; account: string; amount_cents: number }[];
  }[];
  items: { id: string; run_id: string; classification: string; outcome: string; detail: string; auto_action: string | null; created_at: string }[];
  resolutions: ResolutionSummary[];
}

export const money = (cents: number, currency: string) =>
  `${cents < 0 ? "−" : ""}${(Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export const when = (iso: string) => new Date(iso).toLocaleString();
