import { randomBytes } from "node:crypto";
import type { PaymentsConfig } from "../payments/stripe.js";
import { demoCheckoutGateway } from "./demoCheckout.js";
import type { WalletOptions } from "./routes.js";

/**
 * Wallet settings from the environment.
 *
 *   WALLET_SESSION_SECRET  signs demo sign-in tokens. Unset: the wallet API is off.
 *   DEMO_MODE=true         for local demos only: deposits use the demo checkout
 *                          page when there is no STRIPE_SECRET_KEY, and the
 *                          wallet shows the mock bank's chaos switches.
 */
export function loadWalletConfig(
  payments: PaymentsConfig,
  env: NodeJS.ProcessEnv = process.env,
): { payments: PaymentsConfig; wallet: WalletOptions; notes: string[] } {
  const notes: string[] = [];
  const wallet: WalletOptions = { sessionSecret: env.WALLET_SESSION_SECRET || undefined };
  if (!wallet.sessionSecret) notes.push("WALLET_SESSION_SECRET not set: the wallet (/me, /wallet/) is disabled");

  if (env.DEMO_MODE !== "true") return { payments, wallet, notes };

  wallet.demoMode = true;
  wallet.demoBankUrl = env.BANK_API_URL || undefined;
  if (payments.gateway) {
    notes.push("DEMO_MODE: STRIPE_SECRET_KEY is set, so deposits use real Stripe Checkout (test mode)");
    return { payments, wallet, notes };
  }
  wallet.demoCheckout = true;
  notes.push("DEMO_MODE: no STRIPE_SECRET_KEY, so deposits use the demo checkout page. Never use DEMO_MODE outside a local demo.");
  return {
    payments: {
      ...payments,
      gateway: demoCheckoutGateway(payments.appBaseUrl),
      // The demo checkout signs its events with this, and the webhook verifies them with it.
      webhookSecret: payments.webhookSecret ?? `whsec_demo_${randomBytes(24).toString("hex")}`,
    },
    wallet,
    notes,
  };
}
