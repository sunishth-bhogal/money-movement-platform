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

const worker = new OutboxWorker(pool, routingPublisher(routes, fallback), {
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10),
  onError: (err) => console.error("outbox worker poll failed:", err),
});
console.log(`${worker.workerId} publishing to ${url ?? "stdout (set OUTBOX_WEBHOOK_URL to POST events)"}`);
console.log(bank ? `sending payouts to the bank at ${bankUrl}` : "BANK_API_URL not set: payouts stay pending");
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(reconciler);
    // Let the in-flight batch settle so its rows aren't left waiting for a lease to expire.
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
