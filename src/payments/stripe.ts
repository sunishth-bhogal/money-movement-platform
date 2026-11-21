import Stripe from "stripe";

/** What the deposit flow needs from a payment provider. Faked in tests. */
export interface CheckoutGateway {
  createCheckoutSession(
    input: {
      depositId: string;
      amountCents: number;
      currency: string;
      successUrl: string;
      cancelUrl: string;
    },
    /** Sent as Stripe's Idempotency-Key, so a retry returns the same session. */
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }>;
}

export interface PaymentsConfig {
  /** Undefined when STRIPE_SECRET_KEY is not set: POST /deposits then returns 503. */
  gateway?: CheckoutGateway;
  /** Undefined when STRIPE_WEBHOOK_SECRET is not set: the webhook then returns 503. */
  webhookSecret?: string;
  /** Where Stripe sends the browser back to after Checkout, e.g. http://localhost:3000 */
  appBaseUrl: string;
}

/** This project only ever talks to Stripe in test mode. Refuse anything else. */
export function assertTestModeKey(key: string): void {
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_... or rk_test_...). Live keys are refused.");
  }
}

export function stripeCheckoutGateway(secretKey: string): CheckoutGateway {
  assertTestModeKey(secretKey);
  const stripe = new Stripe(secretKey);
  return {
    async createCheckoutSession(input, idempotencyKey) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          // How the webhook finds the deposit. Set at creation, so it works even
          // if we crashed before saving the session id.
          client_reference_id: input.depositId,
          metadata: { deposit_id: input.depositId },
          payment_intent_data: { metadata: { deposit_id: input.depositId } },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.amountCents,
                product_data: { name: "Account deposit (test mode)" },
              },
            },
          ],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey },
      );
      if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a url`);
      return { id: session.id, url: session.url };
    },
  };
}

export function loadPaymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  return {
    gateway: env.STRIPE_SECRET_KEY ? stripeCheckoutGateway(env.STRIPE_SECRET_KEY) : undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    appBaseUrl: (env.APP_BASE_URL || `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ""),
  };
}

/**
 * Verify the Stripe-Signature header against the exact raw request bytes and
 * parse the event. Throws if the signature is missing, wrong, or older than
 * Stripe's default 5-minute tolerance (replay protection).
 */
export function verifyStripeEvent(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}
