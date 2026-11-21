import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { requeueDeadEvent } from "../outbox/outbox.js";
import { RECON_SOURCES } from "../reconciliation/positions.js";
import {
  controlBalances,
  deadEvents,
  flaggedPayouts,
  latestRuns,
  listBreaks,
  runItems,
  stuckPayouts,
  traceBreakKey,
} from "../reconciliation/queries.js";
import { acknowledgeFlag, listResolutions, resolveItem } from "../reconciliation/resolve.js";
import { getRun, listRuns, runReconciliation, type ReconProviders } from "../reconciliation/run.js";

export interface AdminOptions {
  /** Bearer token for /admin. Unset: every /admin route answers 503. */
  token?: string;
  providers: ReconProviders;
}

const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD");
const who = z.string().trim().min(1).max(100);
const note = z.string().trim().min(3).max(2000);

const runBody = z.object({ source: z.enum(RECON_SOURCES as [string, ...string[]]), currency: currency.default("USD") });
const resolveBody = z.object({
  action: z.enum(["accept_provider", "accept_ours"]),
  counterparty: z.enum(["user", "platform"]).optional(),
  note,
  resolved_by: who,
});
const ackBody = z.object({ note, resolved_by: who });

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The operator API behind the dashboard. It can move money (a resolution
 * posts ledger transfers), so every route needs the admin token. One shared
 * token is a stand-in for real operator identity (SSO, per-person roles);
 * `resolved_by` records who said they made each decision.
 */
export function registerAdminRoutes(app: FastifyInstance, pool: pg.Pool, opts: AdminOptions) {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req: FastifyRequest) => {
        if (!opts.token) throw new ApiError(503, "admin_not_configured", "Set ADMIN_TOKEN to enable the admin API.");
        const header = req.headers.authorization ?? "";
        const given = header.startsWith("Bearer ") ? header.slice(7) : "";
        // Compare digests so the comparison takes the same time whatever the length.
        if (!timingSafeEqual(digest(given), digest(opts.token))) {
          throw new ApiError(401, "unauthorized", "Send Authorization: Bearer <ADMIN_TOKEN>.");
        }
      });

      admin.get("/summary", async () => {
        const [accounts, runs, breaks, flagged, stuck, dead] = await Promise.all([
          controlBalances(pool),
          latestRuns(pool),
          listBreaks(pool),
          flaggedPayouts(pool),
          stuckPayouts(pool),
          deadEvents(pool),
        ]);
        return {
          control_accounts: accounts,
          latest_runs: runs,
          open_breaks: breaks.filter((b) => b.outcome === "open").length,
          in_transit: breaks.filter((b) => b.outcome === "in_transit").length,
          flagged_payouts: flagged.filter((f) => !f.acknowledged).length,
          stuck_payouts: stuck.length,
          dead_events: dead.length,
          providers: { mock_bank: Boolean(opts.providers.bank), stripe: Boolean(opts.providers.stripe) },
        };
      });

      admin.get("/reconciliation/runs", async (req) => {
        const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
        return { data: await listRuns(pool, q.limit) };
      });

      // Runs synchronously: the statement is read, compared and stored before
      // the response. 201 when it completed, 502 when the provider could not
      // be read (the failed run is stored, and nothing was changed).
      admin.post("/reconciliation/runs", async (req, reply) => {
        const body = runBody.parse(req.body ?? {});
        const run = await runReconciliation(pool, body.source as (typeof RECON_SOURCES)[number], body.currency, opts.providers);
        if (run.status === "failed") {
          return reply.status(502).send({ error: { code: "provider_unavailable", message: run.error }, run });
        }
        return reply.status(201).send(run);
      });

      admin.get("/reconciliation/runs/:id", async (req) => {
        const id = uuid.parse((req.params as { id: string }).id);
        const run = await getRun(pool, id);
        if (!run) throw new ApiError(404, "run_not_found", "Reconciliation run not found.");
        return { run, items: await runItems(pool, id) };
      });

      admin.get("/reconciliation/breaks", async (req) => {
        const q = z.object({ include_resolved: z.enum(["true", "false"]).optional() }).parse(req.query);
        return { data: await listBreaks(pool, { includeResolved: q.include_resolved === "true" }) };
      });

      admin.post("/reconciliation/items/:id/resolve", async (req, reply) => {
        const id = uuid.parse((req.params as { id: string }).id);
        const body = resolveBody.parse(req.body);
        const { resolution, replayed } = await resolveItem(pool, id, body);
        if (replayed) reply.header("Idempotent-Replayed", "true");
        return reply.status(201).send(resolution);
      });

      admin.get("/reconciliation/trace", async (req) => {
        const q = z.object({ break_key: z.string().regex(/^(payout|deposit|bank_payout|stripe_session):[\w-]+$/) }).parse(req.query);
        return traceBreakKey(pool, q.break_key);
      });

      admin.get("/resolutions", async () => ({ data: await listResolutions(pool) }));

      admin.get("/payouts/flagged", async () => ({
        flagged: await flaggedPayouts(pool),
        stuck: await stuckPayouts(pool),
      }));

      admin.post("/payouts/:id/acknowledge", async (req, reply) => {
        const id = uuid.parse((req.params as { id: string }).id);
        const { resolution, replayed } = await acknowledgeFlag(pool, id, ackBody.parse(req.body));
        if (replayed) reply.header("Idempotent-Replayed", "true");
        return reply.status(201).send(resolution);
      });

      admin.get("/outbox/dead", async () => ({ data: await deadEvents(pool) }));

      // Safe for payout.submit too: the bank call uses the same idempotency key every time.
      admin.post("/outbox/:event_id/requeue", async (req) => {
        const eventId = uuid.parse((req.params as { event_id: string }).event_id);
        if (!(await requeueDeadEvent(pool, eventId))) throw new ApiError(409, "not_dead", "No dead event with this id.");
        return { requeued: true };
      });
    },
    { prefix: "/admin" },
  );
}
