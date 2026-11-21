import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { Deposit } from "../payments/deposits.js";
import type { CheckoutGateway } from "../payments/stripe.js";

/**
 * A stand-in for Stripe Checkout, for demos without a Stripe account
 * (DEMO_MODE=true and no STRIPE_SECRET_KEY).
 *
 * It only replaces the two things that need Stripe's servers: the hosted
 * payment page and Stripe sending us the webhook. The rest is the real path.
 * The "payment page" is a page of the wallet, and choosing an outcome there
 * builds the Checkout Session event Stripe would send, signs it with the
 * webhook secret using Stripe's own SDK, and POSTs it to /webhooks/stripe,
 * where it is verified and applied exactly like a real one.
 *
 * Never enabled alongside a real key: the server refuses to start with both.
 */
export const DEMO_SESSION_PREFIX = "cs_demo_";

export const DEMO_CHECKOUT_OUTCOMES = ["pay", "pay_duplicate_webhook", "bank_debit_fails", "abandon"] as const;
export type DemoCheckoutOutcome = (typeof DEMO_CHECKOUT_OUTCOMES)[number];

export function demoCheckoutGateway(appBaseUrl: string): CheckoutGateway {
  return {
    async createCheckoutSession(input, idempotencyKey) {
      // Deterministic per idempotency key, like Stripe's idempotency: a retry gets the same session.
      const id = DEMO_SESSION_PREFIX + Buffer.from(idempotencyKey).toString("hex").slice(-48);
      return { id, url: `${appBaseUrl}/wallet/?demo_checkout=${encodeURIComponent(input.depositId)}` };
    },
  };
}

type SessionOverrides = { payment_status: "paid" | "unpaid"; status: "complete" | "expired" };

function checkoutEvent(type: string, deposit: Deposit, session: SessionOverrides) {
  return {
    id: `evt_demo_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: deposit.stripe_checkout_session_id,
        object: "checkout.session",
        client_reference_id: deposit.id,
        metadata: { deposit_id: deposit.id },
        amount_total: deposit.amount_cents,
        currency: deposit.currency.toLowerCase(),
        payment_intent: `pi_demo_${deposit.id.replaceAll("-", "").slice(0, 24)}`,
        ...session,
      },
    },
  };
}

/**
 * The webhook deliveries Stripe would make for this outcome, in order. Each
 * is a separate event, except `pay_duplicate_webhook`, which delivers the same
 * event twice (Stripe's at-least-once delivery).
 */
export function demoCheckoutEvents(outcome: DemoCheckoutOutcome, deposit: Deposit): object[] {
  switch (outcome) {
    case "pay":
      return [checkoutEvent("checkout.session.completed", deposit, { payment_status: "paid", status: "complete" })];
    case "pay_duplicate_webhook": {
      const event = checkoutEvent("checkout.session.completed", deposit, { payment_status: "paid", status: "complete" });
      return [event, event];
    }
    case "bank_debit_fails":
      // An async method (e.g. a bank debit): completed but unpaid, then the debit fails.
      return [
        checkoutEvent("checkout.session.completed", deposit, { payment_status: "unpaid", status: "complete" }),
        checkoutEvent("checkout.session.async_payment_failed", deposit, { payment_status: "unpaid", status: "complete" }),
      ];
    case "abandon":
      return [checkoutEvent("checkout.session.expired", deposit, { payment_status: "unpaid", status: "expired" })];
  }
}

/** Sign a payload exactly as Stripe does (the same SDK helper the tests use). */
export function signStripePayload(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}
