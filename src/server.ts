import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { httpBankClient } from "./bank/client.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { loadPaymentsConfig } from "./payments/stripe.js";

// Load .env if present (Node >= 20.12). Variables already set in the shell win.
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const pool = createPool();
await migrate(pool);
const payments = loadPaymentsConfig();
const bankUrl = process.env.BANK_API_URL;
const app = buildApp(pool, {
  logger: true,
  payments,
  bankWebhookSecret: process.env.BANK_WEBHOOK_SECRET || undefined,
  admin: {
    token: process.env.ADMIN_TOKEN || undefined,
    providers: { bank: bankUrl ? httpBankClient(bankUrl) : undefined, stripe: payments.records },
  },
});
if (!process.env.ADMIN_TOKEN) app.log.warn("ADMIN_TOKEN not set: the admin API and dashboard are disabled");

// The admin dashboard (React), once built with `npm run dashboard:build`.
const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dashboard/dist");
if (existsSync(dashboardDir)) {
  app.register(fastifyStatic, { root: dashboardDir, prefix: "/dashboard/" });
  app.get("/dashboard", (_req, reply) => reply.redirect("/dashboard/"));
}
if (!payments.gateway) app.log.warn("STRIPE_SECRET_KEY not set: POST /deposits is disabled");
if (!payments.webhookSecret) app.log.warn("STRIPE_WEBHOOK_SECRET not set: POST /webhooks/stripe is disabled");
if (!process.env.BANK_WEBHOOK_SECRET) app.log.warn("BANK_WEBHOOK_SECRET not set: POST /webhooks/bank is disabled");
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
