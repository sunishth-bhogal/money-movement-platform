import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { authenticate, requireOperator } from "../auth/apiAuth.js";
import { ApiError } from "../errors.js";
import type { PaymentsConfig } from "../payments/stripe.js";
import { issueSessionToken, verifySessionToken } from "../wallet/auth.js";
import {
  DEMO_CHECKOUT_OUTCOMES,
  DEMO_DISPUTE_OUTCOMES,
  DEMO_SESSION_PREFIX,
  demoCheckoutEvents,
  demoDisputeEvent,
  signStripePayload,
  type DemoCheckoutOutcome,
  type DemoDisputeOutcome,
} from "../wallet/demoCheckout.js";
import { createEvent, createOrganizer, getEvent, getOrganizer } from "./catalog.js";
import { ADJUSTMENT_CAUSES, cancelEvent, recordAdjustment, releaseEvent, runPayoutSchedule, takeAdvance } from "./lifecycle.js";
import { createOrder, getOrder } from "./orders.js";
import {
  boxOfficeEvents,
  checkEventInvariants,
  eventDetail,
  isEventOrganizer,
  organizerEvents,
  organizersWithBalances,
  orderTrace,
  publicOrder,
} from "./queries.js";
import { createRefund } from "./refunds.js";
import { organizerOverview } from "./statement.js";

export interface EventRoutesOptions {
  payments: PaymentsConfig;
  adminToken?: string;
  /** Signs organizer sign-in tokens (the wallet's secret; the subject says it is an organizer). */
  sessionSecret?: string;
  /** DEMO_MODE: the portal's demo controls (finish an event now, chargebacks, the bank's switches). */
  demo?: boolean;
  /** Ticket payments go through the demo checkout page instead of Stripe (DEMO_MODE without a Stripe key). */
  demoCheckout?: boolean;
  demoBankUrl?: string;
}

const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD");
const idempotencyKey = z.string().min(8).max(200);
const note = z.string().trim().min(3).max(2000);

const organizerBody = z.object({
  name: z.string().trim().min(1).max(200),
  currency,
  bank_account_number: z.string().regex(/^\d{4,17}$/, "4-17 digits"),
});
const eventBody = z.object({
  name: z.string().trim().min(1).max(200),
  venue: z.string().max(200).optional(),
  currency,
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  fee_bps: z.number().int().min(0).max(10_000).optional(),
  fee_fixed_cents: z.number().int().min(0).max(100_00).optional(),
  hold_hours: z.number().int().min(0).max(24 * 90).optional(),
  advance_bps: z.number().int().min(0).max(10_000).optional(),
  organizers: z.array(z.object({ organizer_id: uuid, share_bps: z.number().int().min(1).max(10_000) })).min(1).max(10),
  ticket_types: z
    .array(z.object({ name: z.string().trim().min(1).max(100), price_cents: z.number().int().positive().max(10_000_00), capacity: z.number().int().positive().max(100_000) }))
    .min(1)
    .max(20),
});
const orderBody = z.object({
  buyer_name: z.string().trim().min(1).max(200),
  buyer_email: z.string().email().max(320),
  // Stripe Checkout caps one payment at $999,999.99; 20 tickets of at most $10,000 stays well below.
  items: z.array(z.object({ ticket_type_id: uuid, quantity: z.number().int().min(1).max(20) })).min(1).max(10),
});
const refundBody = z.object({
  ticket_id: uuid.optional(),
  amount_cents: z.number().int().positive().optional(),
  reason: z.enum(["requested_by_customer", "organizer_goodwill", "duplicate"]),
  note: z.string().trim().max(500).optional(),
});
const adjustmentBody = z.object({
  amount_cents: z.number().int().refine((n) => n !== 0, "not zero").pipe(z.number().min(-100_000_000_00).max(100_000_000_00)),
  cause: z.enum(ADJUSTMENT_CAUSES),
  note,
  decided_by: z.string().trim().min(1).max(100),
  event_id: uuid.optional(),
  order_id: uuid.optional(),
  dispute_id: uuid.optional(),
});

const ORGANIZER_SUBJECT = "organizer:";
const organizers = new WeakMap<FastifyRequest, string>();

function requireKey(req: FastifyRequest): string {
  const parsed = idempotencyKey.safeParse(req.headers["idempotency-key"]);
  if (!parsed.success) throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-200 chars).");
  return parsed.data;
}

/**
 * The ticketing product on top of the money platform:
 *
 *   /box-office   public: browse events, buy tickets (Stripe Checkout), see your order
 *   /organizer    an organizer, signed in: their events, orders, refunds,
 *                 cancellations, early payouts, and the payout statement
 *   /organizers, /events     operators (ADMIN_TOKEN): create organizers and events
 *   /admin/organizers/...    operators: balances, adjustments, the payout schedule
 *
 * Money moves only through the functions in this folder, each one transaction
 * with its ledger postings; none of these routes touches a balance directly.
 */
export function registerEventRoutes(app: FastifyInstance, pool: pg.Pool, opts: EventRoutesOptions) {
  const { payments } = opts;
  const demoCheckout = Boolean(opts.demoCheckout && payments.webhookSecret);

  // Deliver a Stripe-shaped event through the real webhook, signature check included.
  const deliver = async (event: object) => {
    const payload = JSON.stringify(event);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signStripePayload(payload, payments.webhookSecret!) },
      payload,
    });
    return { status: res.statusCode, ...(res.json() as object) };
  };

  // ---- operators: create organizers and events (the core API's auth) --------
  const auth = { adminToken: opts.adminToken, sessionSecret: opts.sessionSecret };
  app.post("/organizers", async (req, reply) => {
    requireOperator(await authenticate(pool, req, auth));
    return reply.status(201).send(await createOrganizer(pool, organizerBody.parse(req.body)));
  });
  app.post("/events", async (req, reply) => {
    requireOperator(await authenticate(pool, req, auth));
    return reply.status(201).send(await createEvent(pool, eventBody.parse(req.body)));
  });

  // ---- the box office (public) ---------------------------------------------
  app.register(
    async (box) => {
      box.get("/config", async () => ({ checkout: demoCheckout ? "demo_checkout" : payments.gateway ? "stripe_test" : "disabled" }));
      box.get("/events", async () => ({ data: await boxOfficeEvents(pool) }));

      box.post("/events/:id/orders", async (req, reply) => {
        if (!payments.gateway) throw new ApiError(503, "payments_not_configured", "Ticket sales are off: set STRIPE_SECRET_KEY, or DEMO_MODE=true.");
        const eventId = uuid.parse((req.params as { id: string }).id);
        // Buyers have no account, so keys are namespaced by event; a key is a random UUID per checkout click.
        const key = `box-office:${eventId}:${requireKey(req)}`;
        const body = orderBody.parse(req.body);
        const { order, replayed } = await createOrder(pool, payments.gateway, key, { event_id: eventId, ...body }, `${payments.appBaseUrl}/portal/`);
        if (replayed) reply.header("Idempotent-Replayed", "true");
        return reply.status(201).send({ order: await publicOrder(pool, order.id), checkout_url: order.checkout_url, replayed });
      });

      // Like GET /deposits/:id: the id is a random UUID only the buyer and Stripe have.
      box.get("/orders/:id", async (req) => {
        const order = await publicOrder(pool, uuid.parse((req.params as { id: string }).id));
        if (!order) throw new ApiError(404, "order_not_found", "Order not found.");
        return order;
      });

      if (demoCheckout) {
        // The demo checkout page's buttons: the events Stripe would send, through the real webhook.
        box.post("/orders/:id/demo-checkout", async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          const { outcome } = z.object({ outcome: z.enum(DEMO_CHECKOUT_OUTCOMES) }).parse(req.body);
          const order = await getOrder(pool, id);
          if (!order) throw new ApiError(404, "order_not_found", "Order not found.");
          if (!order.stripe_checkout_session_id?.startsWith(DEMO_SESSION_PREFIX)) {
            throw new ApiError(409, "not_a_demo_checkout", "This order was not opened with the demo checkout.");
          }
          const deliveries = [];
          for (const event of demoCheckoutEvents(outcome as DemoCheckoutOutcome, order, "order")) deliveries.push(await deliver(event));
          return { deliveries, order: await publicOrder(pool, id) };
        });
      }
    },
    { prefix: "/box-office" },
  );

  // ---- organizers -----------------------------------------------------------
  app.register(
    async (org) => {
      org.addHook("onRequest", async () => {
        if (!opts.sessionSecret) throw new ApiError(503, "portal_not_configured", "Set WALLET_SESSION_SECRET to enable the organizer portal.");
      });
      org.get("/config", async () => ({ sign_in: "demo", demo: Boolean(opts.demo), bank_controls: Boolean(opts.demo && opts.demoBankUrl) }));
      org.get("/demo-organizers", async () => {
        const { rows } = await pool.query("SELECT id, name, currency FROM organizers ORDER BY created_at, id LIMIT 100");
        return { data: rows };
      });
      org.post("/session", async (req, reply) => {
        const { organizer_id } = z.object({ organizer_id: uuid }).parse(req.body);
        const organizer = await getOrganizer(pool, organizer_id);
        if (!organizer) throw new ApiError(404, "organizer_not_found", "No organizer with this id.");
        return reply.status(201).send({ ...issueSessionToken(opts.sessionSecret!, ORGANIZER_SUBJECT + organizer.id), organizer: { id: organizer.id, name: organizer.name } });
      });

      org.register(async (authed) => {
        authed.addHook("onRequest", async (req) => {
          const header = req.headers.authorization ?? "";
          const subject = header.startsWith("Bearer ") ? verifySessionToken(opts.sessionSecret!, header.slice(7)) : null;
          const id = subject?.startsWith(ORGANIZER_SUBJECT) ? subject.slice(ORGANIZER_SUBJECT.length) : null;
          if (!id || !uuid.safeParse(id).success || !(await getOrganizer(pool, id))) throw new ApiError(401, "unauthorized", "Sign in again.");
          organizers.set(req, id);
        });
        const me = (req: FastifyRequest) => organizers.get(req)!;
        /** 404 (not 403) for an event or order that is not theirs, so ids cannot be probed. */
        const myEvent = async (req: FastifyRequest, eventId: string) => {
          if (!(await isEventOrganizer(pool, eventId, me(req)))) throw new ApiError(404, "event_not_found", "Event not found.");
        };
        const myOrder = async (req: FastifyRequest, orderId: string) => {
          const order = await getOrder(pool, orderId);
          if (!order || !(await isEventOrganizer(pool, order.event_id, me(req)))) throw new ApiError(404, "order_not_found", "Order not found.");
          return order;
        };

        // The payout statement, every payout, and what is held: the organizer's home page.
        authed.get("/", async (req) => organizerOverview(pool, me(req)));
        authed.get("/events", async (req) => ({ data: await organizerEvents(pool, me(req)) }));
        authed.get("/events/:id", async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          await myEvent(req, id);
          return eventDetail(pool, id);
        });
        authed.get("/orders/:id", async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          await myOrder(req, id);
          return orderTrace(pool, id, me(req));
        });

        authed.post("/orders/:id/refunds", async (req, reply) => {
          const id = uuid.parse((req.params as { id: string }).id);
          await myOrder(req, id);
          const key = `organizer:${me(req)}:${requireKey(req)}`;
          const body = refundBody.parse(req.body);
          const organizer = (await getOrganizer(pool, me(req)))!;
          const { refund, replayed } = await createRefund(pool, key, { order_id: id, ...body, requested_by: organizer.name });
          if (replayed) reply.header("Idempotent-Replayed", "true");
          return reply.status(201).send({ refund, replayed });
        });

        authed.post("/events/:id/cancel", async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          await myEvent(req, id);
          const { reason } = z.object({ reason: note }).parse(req.body);
          const organizer = (await getOrganizer(pool, me(req)))!;
          const result = await cancelEvent(pool, id, { reason, requested_by: organizer.name });
          return { event: result.event, refunds: result.refunds.length, replayed: result.replayed };
        });

        authed.post("/events/:id/advance", async (req) => {
          const id = uuid.parse((req.params as { id: string }).id);
          await myEvent(req, id);
          return takeAdvance(pool, id, me(req));
        });

        if (opts.demo) {
          // Demo only: make an event "happen" now, so its money is released and paid out at once.
          authed.post("/demo/events/:id/finish", async (req) => {
            const id = uuid.parse((req.params as { id: string }).id);
            await myEvent(req, id);
            const event = await getEvent(pool, id);
            if (event?.status !== "on_sale" || event.released_at) throw new ApiError(409, "not_on_sale", "Only an event on sale can be finished.");
            await pool.query(
              `UPDATE events SET starts_at = LEAST(starts_at, now() - interval '3 hours'), ends_at = LEAST(ends_at, now() - interval '1 second'), hold_hours = 0
                WHERE id = $1 AND status = 'on_sale' AND released_at IS NULL`,
              [id],
            );
            return { release: await releaseEvent(pool, id) };
          });
          authed.post("/demo/orders/:id/dispute", async (req) => {
            const id = uuid.parse((req.params as { id: string }).id);
            const order = await myOrder(req, id);
            if (!payments.webhookSecret) throw new ApiError(503, "payments_not_configured", "No webhook secret to sign the demo event with.");
            const { outcome } = z.object({ outcome: z.enum(DEMO_DISPUTE_OUTCOMES) }).parse(req.body);
            if (!order.stripe_payment_intent_id) throw new ApiError(409, "order_not_paid", "This order was never paid.");
            return { delivery: await deliver(demoDisputeEvent(outcome as DemoDisputeOutcome, order)) };
          });
          authed.post("/demo/run-schedule", async () => ({ released: await runPayoutSchedule(pool) }));
          if (opts.demoBankUrl) {
            const bankUrl = opts.demoBankUrl.replace(/\/$/, "");
            const callBank = async (method: "GET" | "POST", path: string, body?: unknown) => {
              try {
                const res = await fetch(`${bankUrl}${path}`, {
                  method,
                  headers: body === undefined ? {} : { "content-type": "application/json" },
                  body: body === undefined ? undefined : JSON.stringify(body),
                  signal: AbortSignal.timeout(5_000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as Record<string, unknown>;
              } catch (err) {
                throw new ApiError(502, "bank_unreachable", `The mock bank did not answer: ${(err as Error).message}`);
              }
            };
            authed.get("/demo/bank", async () => ({ behaviour: (await callBank("GET", "/_admin/state")).behaviour }));
            authed.post("/demo/bank", async (req) => ({
              behaviour: await callBank("POST", "/_admin/behaviour", z.object({ outage: z.boolean() }).parse(req.body)),
            }));
          }
        }
      });
    },
    { prefix: "/organizer" },
  );
}

/** Operator routes, registered inside /admin (which checks ADMIN_TOKEN). */
export function registerEventAdminRoutes(admin: FastifyInstance, pool: pg.Pool) {
  admin.get("/organizers", async () => ({ data: await organizersWithBalances(pool) }));
  admin.get("/organizers/:id/statement", async (req) => {
    const overview = await organizerOverview(pool, uuid.parse((req.params as { id: string }).id));
    if (!overview) throw new ApiError(404, "organizer_not_found", "Organizer not found.");
    return overview;
  });
  // A person's decision about an organizer's balance: always with a cause and a note.
  admin.post("/organizers/:id/adjustments", async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const key = requireKey(req);
    const { adjustment, replayed } = await recordAdjustment(pool, key, { organizer_id: id, ...adjustmentBody.parse(req.body) });
    if (replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(201).send(adjustment);
  });
  admin.get("/orders/:id/trace", async (req) => {
    const trace = await orderTrace(pool, uuid.parse((req.params as { id: string }).id));
    if (!trace) throw new ApiError(404, "order_not_found", "Order not found.");
    return trace;
  });
  admin.post("/payout-schedule/run", async () => ({ released: await runPayoutSchedule(pool) }));
  admin.get("/events/invariants", async () => {
    const problems = await checkEventInvariants(pool);
    return { ok: problems.length === 0, problems };
  });
}
