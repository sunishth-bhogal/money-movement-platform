// The outbox worker as its own process: `npm run worker`. Run as many copies
// as you like; they coordinate through Postgres row locks and leases.
import { createPool } from "../db.js";
import { migrate } from "../migrate.js";
import { httpPublisher, logPublisher } from "./publishers.js";
import { OutboxWorker } from "./worker.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const pool = createPool();
await migrate(pool);

const url = process.env.OUTBOX_WEBHOOK_URL;
const publisher = url ? httpPublisher(url) : logPublisher();
const worker = new OutboxWorker(pool, publisher, {
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10),
  onError: (err) => console.error("outbox worker poll failed:", err),
});
console.log(`${worker.workerId} publishing to ${url ?? "stdout (set OUTBOX_WEBHOOK_URL to POST events)"}`);
worker.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Let the in-flight batch settle so its rows aren't left waiting for a lease to expire.
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
