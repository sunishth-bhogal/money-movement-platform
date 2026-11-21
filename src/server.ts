import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { httpBankClient } from "./bank/client.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { loadPaymentsConfig } from "./payments/stripe.js";
import { loadWalletConfig } from "./wallet/config.js";

// Load .env if present (Node >= 20.12). Variables already set in the shell win.
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const pool = createPool();
await migrate(pool);
const bankUrl = process.env.BANK_API_URL;
const { payments, wallet, notes } = loadWalletConfig(loadPaymentsConfig());
const app = buildApp(pool, {
  logger: true,
  payments,
  bankWebhookSecret: process.env.BANK_WEBHOOK_SECRET || undefined,
  admin: {
    token: process.env.ADMIN_TOKEN || undefined,
    providers: { bank: bankUrl ? httpBankClient(bankUrl) : undefined, stripe: payments.records },
  },
  wallet,
});
for (const note of notes) app.log.warn(note);
if (!process.env.ADMIN_TOKEN) app.log.warn("ADMIN_TOKEN not set: the admin API and dashboard are disabled");

// The admin dashboard and the user wallet (React), once built with
// `npm run dashboard:build` and `npm run wallet:build`.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const [name, dir] of [
  ["dashboard", "../dashboard/dist"],
  ["wallet", "../wallet/dist"],
] as const) {
  const root = path.resolve(here, dir);
  if (!existsSync(root)) continue;
  app.register(fastifyStatic, { root, prefix: `/${name}/`, decorateReply: name === "dashboard" });
  app.get(`/${name}`, (_req, reply) => reply.redirect(`/${name}/`));
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
