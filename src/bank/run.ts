// The mock bank as its own process: `npm run mock-bank`. It plays the part of
// an external provider: its own state, its own clock, webhooks back to us.
import { MockBank } from "./mockBank.js";
import { buildMockBankServer, httpWebhookDeliverer } from "./mockBankServer.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const webhookUrl = process.env.BANK_WEBHOOK_URL ?? "http://localhost:3000/webhooks/bank";
const secret = process.env.BANK_WEBHOOK_SECRET;
if (!secret) throw new Error("BANK_WEBHOOK_SECRET must be set (the same value the API uses to verify webhooks)");

const bank = new MockBank({
  deliver: httpWebhookDeliverer(webhookUrl, secret),
  behaviour: { settleAfterMs: Number(process.env.BANK_SETTLE_AFTER_MS ?? 5_000) },
});
const app = buildMockBankServer(bank);
const port = Number(process.env.BANK_PORT ?? 4000);
await app.listen({ host: "0.0.0.0", port });
console.log(`mock bank on :${port}, webhooks to ${webhookUrl}`);

// The bank's own back office: settle due payouts and retry undelivered webhooks.
const timer = setInterval(() => {
  bank.processDue().catch((err) => console.error("mock bank processing failed:", err));
}, 500);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  });
}
