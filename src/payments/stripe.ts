import Stripe from "stripe";

/** One line on the Checkout page. */
export interface CheckoutLineItem {
  name: string;
  unitAmountCents: number;
  quantity: number;
}

export interface CheckoutSessionInput {
  /**
   * What the session pays for: a wallet deposit or a ticket order. Sent as
   * client_reference_id and as metadata (`deposit_id` / `order_id`), so the
   * webhook finds it even if we crashed before saving the session id.
   */
  reference: { type: "deposit" | "order"; id: string };
  lineItems: CheckoutLineItem[];
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

/** What the deposit and ticket flows need from a payment provider. Faked in tests. */
export interface CheckoutGateway {
  createCheckoutSession(
    input: CheckoutSessionInput,
    /** Sent as Stripe's Idempotency-Key, so a retry returns the same session. */
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }>;
}

/** The metadata a session carries for its reference: { deposit_id } or { order_id }. */
export function referenceMetadata(reference: CheckoutSessionInput["reference"]): Record<string, string> {
  return { [`${reference.type}_id`]: reference.id };
}

/** A Checkout Session as Stripe reports it, with the fields reconciliation compares. */
export interface StripeSessionRecord {
  id: string;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  /** "open" | "complete" | "expired" (a string, as newer API versions may add values). */
  status: string | null;
  /** "paid" | "unpaid" | "no_payment_required" */
  payment_status: string;
  amount_total: number | null;
  /** Lowercase, as Stripe sends it. */
  currency: string | null;
  payment_intent: string | null;
  /** Unix seconds. */
  created: number;
}

/**
 * Stripe's own record of what it collected for us. Reconciliation reads it
 * instead of trusting the webhooks we happened to receive. Faked in tests.
 */
export interface StripeRecordSource {
  listCheckoutSessions(
    page: { limit?: number; starting_after?: string },
    signal?: AbortSignal,
  ): Promise<{ data: StripeSessionRecord[]; has_more: boolean }>;
}

export function stripeRecordSource(secretKey: string): StripeRecordSource {
  assertTestModeKey(secretKey);
  const stripe = new Stripe(secretKey);
  return {
    async listCheckoutSessions(page) {
      // The SDK takes a timeout rather than an AbortSignal.
      const res = await stripe.checkout.sessions.list(
        { limit: page.limit ?? 100, ...(page.starting_after ? { starting_after: page.starting_after } : {}) },
        { timeout: 20_000 },
      );
      return {
        has_more: res.has_more,
        data: res.data.map((s) => ({
          id: s.id,
          client_reference_id: s.client_reference_id,
          metadata: s.metadata,
          status: s.status,
          payment_status: s.payment_status,
          amount_total: s.amount_total,
          currency: s.currency,
          payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
          created: s.created,
        })),
      };
    },
  };
}

/** Every page, or nothing: a partial list would make the missing sessions look uncollected. */
export async function listAllStripeSessions(source: StripeRecordSource, signal?: AbortSignal): Promise<StripeSessionRecord[]> {
  const all: StripeSessionRecord[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const page = await source.listCheckoutSessions({ limit: 100, starting_after }, signal);
    all.push(...page.data);
    if (!page.has_more || page.data.length === 0) return all;
    starting_after = page.data[page.data.length - 1].id;
  }
}

export interface PaymentsConfig {
  /** Undefined when STRIPE_SECRET_KEY is not set: POST /deposits then returns 503. */
  gateway?: CheckoutGateway;
  /** Undefined when STRIPE_WEBHOOK_SECRET is not set: the webhook then returns 503. */
  webhookSecret?: string;
  /** Where Stripe sends the browser back to after Checkout, e.g. http://localhost:3000 */
  appBaseUrl: string;
  /** Stripe's records, for reconciliation. Undefined without STRIPE_SECRET_KEY. */
  records?: StripeRecordSource;
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
          // How the webhook finds the deposit or order. Set at creation, so it
          // works even if we crashed before saving the session id.
          client_reference_id: input.reference.id,
          metadata: referenceMetadata(input.reference),
          payment_intent_data: { metadata: referenceMetadata(input.reference) },
          line_items: input.lineItems.map((item) => ({
            quantity: item.quantity,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: item.unitAmountCents,
              product_data: { name: item.name },
            },
          })),
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
    records: env.STRIPE_SECRET_KEY ? stripeRecordSource(env.STRIPE_SECRET_KEY) : undefined,
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
