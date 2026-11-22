// The outbox worker as its own process: `npm run worker`. Run as many copies
// as you like; they coordinate through Postgres row locks and leases.
//
// With BANK_API_URL set, it also sends payouts to the bank (`payout.submit`
// events) and runs the payout reconciler, which asks the bank about payouts
// that have gone quiet.
import { httpBankClient } from "../bank/client.js";
import { createPool } from "../db.js";
import { migrate } from "../migrate.js";
import { PAYOUT_SUBMIT_EVENT } from "../payouts/payouts.js";
import { reconcilePayouts } from "../payouts/reconcile.js";
import { payoutSubmitter } from "../payouts/submitter.js";
import { loadPaymentsConfig } from "../payments/stripe.js";
import { runReconciliation } from "../reconciliation/run.js";
import { ApiError } from "../errors.js";
import { runPayoutSchedule } from "../events/lifecycle.js";
import { demoRefundGateway, REFUND_SUBMIT_EVENT, refundSubmitter, stripeRefundGateway } from "../events/refunds.js";
import { httpPublisher, logPublisher, routingPublisher } from "./publishers.js";
import { OutboxWorker, type Publisher } from "./worker.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const pool = createPool();
await migrate(pool);

const url = process.env.OUTBOX_WEBHOOK_URL;
const fallback = url ? httpPublisher(url) : logPublisher();
const bankUrl = process.env.BANK_API_URL;
const bank = bankUrl ? httpBankClient(bankUrl) : undefined;
const routes: Record<string, Publisher> = {};
if (bank) routes[PAYOUT_SUBMIT_EVENT] = payoutSubmitter(pool, bank);
// Ticket refunds go to Stripe (test mode), or, in a local demo without a key, succeed at once.
const refunds = process.env.STRIPE_SECRET_KEY
  ? stripeRefundGateway(process.env.STRIPE_SECRET_KEY)
  : process.env.DEMO_MODE === "true"
    ? demoRefundGateway()
    : undefined;
if (refunds) routes[REFUND_SUBMIT_EVENT] = refundSubmitter(pool, refunds);

const worker = new OutboxWorker(pool, routingPublisher(routes, fallback), {
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10),
  onError: (err) => console.error("outbox worker poll failed:", err),
});
console.log(`${worker.workerId} publishing to ${url ?? "stdout (set OUTBOX_WEBHOOK_URL to POST events)"}`);
console.log(bank ? `sending payouts to the bank at ${bankUrl}` : "BANK_API_URL not set: payouts stay pending");
console.log(refunds ? `sending ticket refunds to ${process.env.STRIPE_SECRET_KEY ? "Stripe (test mode)" : "the demo refund gateway"}` : "no STRIPE_SECRET_KEY or DEMO_MODE: refunds stay pending");
worker.start();

// Every copy can run the reconciler: applying the bank's answer locks the
// payout row and is idempotent, so two copies asking at once is harmless.
const reconcileEveryMs = Number(process.env.PAYOUT_RECONCILE_EVERY_MS ?? 30_000);
const quietForMs = Number(process.env.PAYOUT_RECONCILE_QUIET_MS ?? 60_000);
const reconciler = bank
  ? setInterval(() => {
      reconcilePayouts(pool, bank, { quietForMs })
        .then((r) => r.checked && console.log("payout reconcile:", JSON.stringify({ ...r, outcomes: undefined })))
        .catch((err) => console.error("payout reconcile failed:", err));
    }, reconcileEveryMs)
  : undefined;

// Organizer payouts: release each event's money once it has happened (and its
// hold period passed), and pay it out. Idempotent, so every copy can run it.
const scheduleEveryMs = Number(process.env.PAYOUT_SCHEDULE_EVERY_MS ?? 30_000);
const schedule =
  scheduleEveryMs > 0
    ? setInterval(() => {
        runPayoutSchedule(pool)
          .then((r) => r.length && console.log("organizer payouts:", JSON.stringify(r.map((x) => ({ event: x.event_id, organizers: x.organizers.length })))))
          .catch((err) => console.error("organizer payout schedule failed:", err));
      }, scheduleEveryMs)
    : undefined;

// Full reconciliation against each provider's statement. Copies take turns:
// a run holds an advisory lock, and a copy that finds one running skips.
const stripeRecords = loadPaymentsConfig().records;
const fullEveryMs = Number(process.env.RECONCILE_EVERY_MS ?? 300_000);
const currencies = (process.env.RECONCILE_CURRENCIES ?? "USD").split(",").map((c) => c.trim().toUpperCase());
const fullRuns =
  fullEveryMs > 0 && (bank || stripeRecords)
    ? setInterval(async () => {
        for (const currency of currencies) {
          for (const source of [bank && "mock_bank", stripeRecords && "stripe"].filter(Boolean) as ("mock_bank" | "stripe")[]) {
            try {
              const r = await runReconciliation(pool, source, currency, { bank, stripe: stripeRecords });
              console.log(`reconciliation ${source} ${currency}: ${r.status}`, r.status === "completed" ? `open=${r.open_breaks} auto=${r.auto_resolved}` : r.error);
            } catch (err) {
              if (!(err instanceof ApiError && err.code === "run_in_progress")) console.error(`reconciliation ${source} ${currency} failed:`, err);
            }
          }
        }
      }, fullEveryMs)
    : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(reconciler);
    clearInterval(schedule);
    clearInterval(fullRuns);
    // Let the in-flight batch settle so its rows aren't left waiting for a lease to expire.
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
