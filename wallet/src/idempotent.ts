// Client-side idempotency for the wallet's forms.
//
// One Idempotency-Key per *intended operation*, not per click. The key is
// made when a request is first sent and kept for as long as the form says the
// same thing, so a double-click, a "Send" pressed again after a slow answer,
// or a retry after a lost response all reach the server with the same key and
// move money once. Changing a field, or pressing "Start a new one", is a new
// intention and gets a new key.

export function newIdempotencyKey(): string {
  // crypto.randomUUID needs a secure context (https or localhost). Opened over
  // plain http on a LAN address it is missing, so fall back to random bytes.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Draft {
  private key: string | null = null;
  private body: string | null = null;

  constructor(private readonly makeKey: () => string = newIdempotencyKey) {}

  /** The key to send this body with: the same one while the body is unchanged. */
  keyFor(body: unknown): string {
    const canonical = JSON.stringify(body);
    if (this.key === null || this.body !== canonical) {
      this.key = this.makeKey();
      this.body = canonical;
    }
    return this.key;
  }

  /** Forget the key: the next submit is a new operation, even with the same body. */
  reset(): void {
    this.key = null;
    this.body = null;
  }
}

/** What the person is told after the requests sent for one key. */
export interface Attempts {
  sent: number;
  answered: number;
  replayed: number;
}

export function describeAttempts(a: Attempts): string | null {
  if (a.sent <= 1) return null;
  const moved = a.answered > 0 ? "moved money once" : "is being sent";
  const replays = a.replayed > 0 ? ` The server answered ${a.replayed} of them from the first one (Idempotent-Replayed).` : "";
  return `Sent ${a.sent} times with the same Idempotency-Key, and it ${moved}.${replays}`;
}

/** "12.50" → 1250. Strings, not floats, so no amount is ever rounded. null when it is not a valid amount. */
export function parseAmount(input: string): number | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}
