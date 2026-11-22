import type pg from "pg";
import { systemAccount } from "../payouts/payouts.js";

/**
 * The platform's control accounts for ticket money, and the arithmetic that
 * splits it. All amounts are integer cents; every split adds up exactly.
 */

/** Money Stripe holds for us. The same account deposits use. */
export const stripeClearingAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "stripe_clearing", "Stripe clearing", currency);
/** What the platform has earned in ticket fees. */
export const platformFeesAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "platform_fees", "Platform fees", currency);
/** Refunds taken from organizers (and the platform's fee share) that Stripe has not confirmed yet. */
export const refundsInFlightAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "refunds_in_flight", "Refunds in flight", currency);
/** Refunds Stripe has sent back to customers. */
export const stripeRefundsAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "stripe_refunds", "Refunded through Stripe", currency);
/** Money Stripe took from us for chargebacks (the disputed amount and its fee). */
export const stripeDisputesAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "stripe_disputes", "Chargebacks through Stripe", currency);
/** The other side of a person's adjustment to an organizer's balance. */
export const organizerAdjustmentsAccount = (c: pg.PoolClient, currency: string) =>
  systemAccount(c, "organizer_adjustments", "Organizer adjustments", currency);

/** What Stripe charges per chargeback, passed on to the organizer, win or lose. */
export const DISPUTE_FEE_CENTS = 1500;

/** The platform fee on one ticket: fee_bps of the price (rounded half up) plus a fixed part, never more than the price. */
export function ticketFee(priceCents: number, feeBps: number, feeFixedCents: number): number {
  const proportional = Number((BigInt(priceCents) * BigInt(feeBps) + 5000n) / 10000n);
  return Math.min(priceCents, proportional + feeFixedCents);
}

/**
 * Split `amount` in proportion to `weights`, with no part above its cap.
 * Largest remainder: everyone gets the floor of their exact share, and the
 * cents left over go to the largest fractional parts (ties: the earlier one).
 * The parts always add up to `amount` exactly.
 */
export function allocate(amount: number, parts: { weight: number; cap?: number }[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`cannot allocate ${amount}`);
  const caps = parts.map((p) => p.cap ?? Number.MAX_SAFE_INTEGER);
  if (caps.reduce((a, b) => a + b, 0) < amount) throw new Error(`cannot allocate ${amount}: caps add up to less`);
  const total = parts.reduce((sum, p) => sum + BigInt(p.weight), 0n);
  if (amount === 0) return parts.map(() => 0);
  if (total === 0n) throw new Error("cannot allocate against zero weights");

  const exact = parts.map((p) => BigInt(amount) * BigInt(p.weight));
  const result = exact.map((e, i) => Math.min(caps[i], Number(e / total)));
  let left = amount - result.reduce((a, b) => a + b, 0);
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = exact[a] % total;
      const rb = exact[b] % total;
      return ra === rb ? a - b : ra > rb ? -1 : 1;
    });
  while (left > 0) {
    let gave = false;
    for (const i of order) {
      if (left === 0) break;
      if (result[i] < caps[i]) {
        result[i]++;
        left--;
        gave = true;
      }
    }
    if (!gave) throw new Error("allocation could not place every cent");
  }
  return result;
}

/** One organizer's part of an order's money (a sale, or what a refund or dispute takes back). */
export interface Share {
  organizer_id: string;
  /** Of the ticket price. */
  gross_cents: number;
  /** Of the platform fee inside that price. */
  fee_cents: number;
}

/**
 * How an order's money divides between its event's organizers. The gross is
 * split by their shares; the fee follows each organizer's gross, so no one's
 * fee can exceed what they sold.
 */
export function saleShares(
  amountCents: number,
  feeCents: number,
  organizers: { organizer_id: string; share_bps: number }[],
): Share[] {
  const gross = allocate(
    amountCents,
    organizers.map((o) => ({ weight: o.share_bps })),
  );
  const fee = allocate(
    feeCents,
    gross.map((g) => ({ weight: g, cap: g })),
  );
  return organizers.map((o, i) => ({ organizer_id: o.organizer_id, gross_cents: gross[i], fee_cents: fee[i] }));
}

/**
 * What a refund or dispute of `amountCents` takes back from each organizer,
 * given what is still unrefunded of each one's sale.
 *
 * The amount is split in proportion to what each organizer has left, never
 * more than that. The platform gives back the same fraction of its remaining
 * fee (rounded down), so a full refund returns the whole fee exactly, and a
 * series of partial refunds can never return more fee than was charged.
 */
export function reductionShares(amountCents: number, remaining: Share[]): Share[] {
  const gross = allocate(
    amountCents,
    remaining.map((r) => ({ weight: r.gross_cents, cap: r.gross_cents })),
  );
  return remaining.map((r, i) => {
    const g = gross[i];
    const fee =
      g === r.gross_cents ? r.fee_cents : r.gross_cents === 0 ? 0 : Number((BigInt(g) * BigInt(r.fee_cents)) / BigInt(r.gross_cents));
    return { organizer_id: r.organizer_id, gross_cents: g, fee_cents: fee };
  });
}

/** sale − every reduction so far, per organizer. */
export function remainingShares(sale: Share[], reductions: Share[][]): Share[] {
  return sale.map((s) => {
    let gross = s.gross_cents;
    let fee = s.fee_cents;
    for (const r of reductions) {
      const mine = r.find((x) => x.organizer_id === s.organizer_id);
      if (mine) {
        gross -= mine.gross_cents;
        fee -= mine.fee_cents;
      }
    }
    return { organizer_id: s.organizer_id, gross_cents: gross, fee_cents: fee };
  });
}

export const formatCents = (cents: number, currency = "USD") =>
  `${cents < 0 ? "−" : ""}${currency === "USD" ? "$" : `${currency} `}${(Math.abs(cents) / 100).toFixed(2)}`;
