import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { referenceMetadata, type CheckoutGateway } from "../payments/stripe.js";

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
      const { type, id: ref } = input.reference;
      // Deposits are paid on the wallet's demo page, ticket orders on the portal's box office.
      const url =
        type === "order"
          ? `${appBaseUrl}/portal/?demo_checkout_order=${encodeURIComponent(ref)}`
          : `${appBaseUrl}/wallet/?demo_checkout=${encodeURIComponent(ref)}`;
      return { id, url };
    },
  };
}

type SessionOverrides = { payment_status: "paid" | "unpaid"; status: "complete" | "expired" };

/** What the demo checkout pays: a deposit or a ticket order (both have these fields). */
export interface DemoCheckoutTarget {
  id: string;
  stripe_checkout_session_id: string | null;
  amount_cents: number;
  currency: string;
}

/** The payment intent id the demo gives a payment, the same every time (disputes find the order by it). */
export const demoPaymentIntentId = (id: string) => `pi_demo_${id.replaceAll("-", "").slice(0, 24)}`;

function checkoutEvent(type: string, deposit: DemoCheckoutTarget, session: SessionOverrides, kind: "deposit" | "order") {
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
        metadata: referenceMetadata({ type: kind, id: deposit.id }),
        amount_total: deposit.amount_cents,
        currency: deposit.currency.toLowerCase(),
        payment_intent: demoPaymentIntentId(deposit.id),
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
export function demoCheckoutEvents(outcome: DemoCheckoutOutcome, target: DemoCheckoutTarget, kind: "deposit" | "order" = "deposit"): object[] {
  const ev = (type: string, session: SessionOverrides) => checkoutEvent(type, target, session, kind);
  switch (outcome) {
    case "pay":
      return [ev("checkout.session.completed", { payment_status: "paid", status: "complete" })];
    case "pay_duplicate_webhook": {
      const event = ev("checkout.session.completed", { payment_status: "paid", status: "complete" });
      return [event, event];
    }
    case "bank_debit_fails":
      // An async method (e.g. a bank debit): completed but unpaid, then the debit fails.
      return [
        ev("checkout.session.completed", { payment_status: "unpaid", status: "complete" }),
        ev("checkout.session.async_payment_failed", { payment_status: "unpaid", status: "complete" }),
      ];
    case "abandon":
      return [ev("checkout.session.expired", { payment_status: "unpaid", status: "expired" })];
  }
}

export const DEMO_DISPUTE_OUTCOMES = ["open", "won", "lost"] as const;
export type DemoDisputeOutcome = (typeof DEMO_DISPUTE_OUTCOMES)[number];

/**
 * The webhook Stripe would send when a customer's bank charges back a ticket
 * payment (open), and when the dispute is decided (won / lost). The dispute
 * id is fixed per order, so "open" twice is the same dispute.
 */
export function demoDisputeEvent(outcome: DemoDisputeOutcome, order: { id: string; amount_cents: number; currency: string; stripe_payment_intent_id: string | null }) {
  return {
    id: `evt_demo_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: outcome === "open" ? "charge.dispute.created" : "charge.dispute.closed",
    data: {
      object: {
        id: `dp_demo_${order.id.replaceAll("-", "").slice(0, 24)}`,
        object: "dispute",
        amount: order.amount_cents,
        currency: order.currency.toLowerCase(),
        payment_intent: order.stripe_payment_intent_id,
        status: outcome === "open" ? "needs_response" : outcome,
        reason: "fraudulent",
      },
    },
  };
}

/** Sign a payload exactly as Stripe does (the same SDK helper the tests use). */
export function signStripePayload(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}
