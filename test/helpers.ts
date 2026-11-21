import { randomUUID } from "node:crypto";
import { createPool } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createAccount } from "../src/ledger/accounts.js";
import { createTransfer } from "../src/ledger/transfers.js";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/money_test";

export const pool = createPool();
export const app = buildApp(pool);

/** A system account that can go negative; stands in for deposits until Stripe exists. */
let funding: Promise<string> | undefined;
function fundingAccount(): Promise<string> {
  funding ??= createAccount(pool, { name: "funding", currency: "USD", kind: "system" }).then((a) => a.id);
  return funding;
}

export async function userWithBalance(cents: number, name = "user"): Promise<string> {
  const account = await createAccount(pool, { name, currency: "USD" });
  if (cents > 0) {
    await createTransfer(pool, randomUUID(), {
      from_account_id: await fundingAccount(),
      to_account_id: account.id,
      amount_cents: cents,
      currency: "USD",
    });
  }
  return account.id;
}

export async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ balance_cents: number }>("SELECT balance_cents FROM accounts WHERE id = $1", [
    accountId,
  ]);
  return rows[0].balance_cents;
}

export function postTransfer(key: string | undefined, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/transfers",
    headers: key === undefined ? {} : { "idempotency-key": key },
    payload: body,
  });
}

export function usd(from: string, to: string, amount_cents: number) {
  return { from_account_id: from, to_account_id: to, amount_cents, currency: "USD" };
}
