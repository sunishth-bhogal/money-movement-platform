import { describe, expect, it } from "vitest";
import { describeAttempts, Draft, newIdempotencyKey, parseAmount } from "../wallet/src/idempotent.js";

// The wallet's client-side idempotency rules. The server side of the same
// story (one key, one transfer) is in wallet.test.ts.
describe("Draft: one Idempotency-Key per intended operation", () => {
  it("reuses the key while the form says the same thing (double-click, retry after a lost response)", () => {
    const d = new Draft();
    const body = { to_account_id: "bob", amount_cents: 500 };
    const k = d.keyFor(body);
    expect(d.keyFor({ ...body })).toBe(k);
    expect(d.keyFor(body)).toBe(k);
  });

  it("makes a new key when the form changes, or after Start a new one", () => {
    const d = new Draft();
    const a = d.keyFor({ amount_cents: 500 });
    const b = d.keyFor({ amount_cents: 600 });
    expect(b).not.toBe(a);
    d.reset();
    expect(d.keyFor({ amount_cents: 600 })).not.toBe(b);
  });

  it("generates UUID v4 keys", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("parseAmount", () => {
  it("turns dollars into integer cents without floating point", () => {
    expect(parseAmount("12.5")).toBe(1250);
    expect(parseAmount("0.10")).toBe(10);
    expect(parseAmount(" 7 ")).toBe(700);
    // 0.1 + 0.2 style traps: computed from the digits, not from a float.
    expect(parseAmount("1.15")).toBe(115);
    expect(parseAmount("4.35")).toBe(435);
  });

  it("refuses anything that is not a positive amount with at most two decimals", () => {
    for (const bad of ["", "0", "0.00", "-5", "1.234", "abc", "1e3", "1,000"]) expect(parseAmount(bad)).toBeNull();
  });
});

describe("describeAttempts", () => {
  it("says nothing for a single request, and explains replays for more", () => {
    expect(describeAttempts({ sent: 1, answered: 1, replayed: 0 })).toBeNull();
    expect(describeAttempts({ sent: 2, answered: 2, replayed: 1 })).toContain("moved money once");
  });
});
