// Creates a system "funding" account and two users, and funds Alice with $50.00
// through a normal transfer, so transfers can be tried without Stripe. Real
// deposits go through POST /deposits (Stripe Checkout, test mode).
import { randomUUID } from "node:crypto";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createAccount } from "../src/ledger/accounts.js";
import { createTransfer } from "../src/ledger/transfers.js";

const pool = createPool();
await migrate(pool);
const funding = await createAccount(pool, { name: "Funding (simulated deposits)", currency: "USD", kind: "system" });
const alice = await createAccount(pool, { name: "Alice", currency: "USD" });
const bob = await createAccount(pool, { name: "Bob", currency: "USD" });
await createTransfer(pool, `seed-${randomUUID()}`, {
  from_account_id: funding.id,
  to_account_id: alice.id,
  amount_cents: 5000,
  currency: "USD",
});
console.log(JSON.stringify({ funding: funding.id, alice: alice.id, bob: bob.id }, null, 2));
await pool.end();
