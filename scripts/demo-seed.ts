// Seeds the demo: three users with a history that shows every state the
// wallet can show (`npm run demo:seed`, or the `seed` service in
// docker-compose.yml, which runs it for you).
//
// Funding goes straight into the ledger (a system transfer). Everything else
// goes through the running API, signed in as each user, with fixed
// Idempotency-Keys. So running this twice changes nothing: the second run is
// answered from the first one, which is the point of the whole platform.
//
// The withdrawals play out live after seeding: the worker sends them to the
// mock bank, which settles, fails or returns them a few seconds later.
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createTransfer } from "../src/ledger/transfers.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the environment
}

const API = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
const pool = createPool();
await migrate(pool);

async function api<T = { item: { title: string; status_label: string }; replayed: boolean }>(
  token: string | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  key?: string,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok && res.status !== 422) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, json };
}

/** One account per demo name, found again on a re-run. */
async function demoUser(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE kind = 'user' AND name = $1 ORDER BY created_at LIMIT 1",
    [name],
  );
  if (rows[0]) return rows[0].id;
  const created = await pool.query<{ id: string }>("INSERT INTO accounts (name, currency) VALUES ($1, 'USD') RETURNING id", [name]);
  return created.rows[0].id;
}

async function fundingAccount(): Promise<string> {
  await pool.query(
    `INSERT INTO accounts (name, currency, kind, system_code) VALUES ('Demo funding (USD)', 'USD', 'system', 'demo_funding')
     ON CONFLICT (system_code, currency) WHERE system_code IS NOT NULL DO NOTHING`,
  );
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE system_code = 'demo_funding' AND currency = 'USD'");
  return rows[0].id;
}

const log = (who: string, what: string, r: { json: { item: { title: string; status_label: string }; replayed: boolean } }) =>
  console.log(`  ${who.padEnd(6)} ${what.padEnd(44)} → ${r.json.item.status_label}${r.json.replayed ? "  (replayed: already seeded)" : ""}`);

try {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`The API is not answering at ${API}. Start it first (npm run dev), or set API_URL.`);
  const config = (await api<{ deposits: string }>(null, "GET", "/me/config")).json;

  const funding = await fundingAccount();
  const ids = { alice: await demoUser("Alice"), bob: await demoUser("Bob"), carol: await demoUser("Carol") };
  for (const [who, cents] of [
    ["alice", 50_000],
    ["bob", 12_000],
  ] as const) {
    await createTransfer(
      pool,
      `demo-seed:funding:${who}`,
      { from_account_id: funding, to_account_id: ids[who], amount_cents: cents, currency: "USD" },
      { scope: "system" },
    );
  }

  const token: Record<keyof typeof ids, string> = { alice: "", bob: "", carol: "" };
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    token[who] = (await api<{ token: string }>(null, "POST", "/me/session", { account_id: ids[who] })).json.token;
  }

  console.log("Seeding demo activity:");
  if (config.deposits === "demo_checkout") {
    const pay = async (who: keyof typeof ids, cents: number, key: string, outcome: string | null, what: string) => {
      const started = await api<{ item: { object_id: string; state: string; title: string; status_label: string }; replayed: boolean }>(
        token[who], "POST", "/me/deposits", { amount_cents: cents }, key,
      );
      if (outcome && started.json.item.state === "pending") {
        await api(token[who], "POST", `/me/deposits/${started.json.item.object_id}/demo-checkout`, { outcome });
      }
      const now = await api<{ title: string; status_label: string }>(token[who], "GET", `/me/deposits/${started.json.item.object_id}`);
      log(who, what, { json: { item: now.json, replayed: started.json.replayed } });
    };
    await pay("alice", 7_500, "demo-seed:deposit:1", "pay", "adds $75.00 by card");
    await pay("carol", 4_000, "demo-seed:deposit:2", "bank_debit_fails", "adds $40.00 by bank debit, which fails");
    await pay("bob", 2_500, "demo-seed:deposit:3", null, "starts adding $25.00, not paid yet");
  } else {
    console.log(`  (deposits are "${config.deposits}", so no demo deposits; set DEMO_MODE=true without a Stripe key for them)`);
  }

  const send = async (from: keyof typeof ids, to: keyof typeof ids, cents: number, key: string) =>
    log(from, `sends $${(cents / 100).toFixed(2)} to ${to}`, await api(token[from], "POST", "/me/transfers", { to_account_id: ids[to], amount_cents: cents }, key));
  await send("alice", "bob", 4_250, "demo-seed:transfer:1");
  await send("bob", "carol", 1_500, "demo-seed:transfer:2");
  await send("carol", "alice", 10_000, "demo-seed:transfer:3"); // more than Carol has: rejected
  await send("alice", "carol", 2_000, "demo-seed:transfer:4");

  const withdraw = async (who: keyof typeof ids, cents: number, account: string, key: string, what: string) =>
    log(who, what, await api(token[who], "POST", "/me/payouts", { amount_cents: cents, bank_account_number: account }, key));
  await withdraw("alice", 6_000, "000123451111", "demo-seed:payout:1", "withdraws $60.00 (will pay out)");
  await withdraw("bob", 3_000, "000123450002", "demo-seed:payout:2", "withdraws $30.00 (bank will fail it)");
  await withdraw("alice", 2_500, "000123450005", "demo-seed:payout:3", "withdraws $25.00 (will be returned)");
  await withdraw("bob", 1_000, "000123450004", "demo-seed:payout:4", "withdraws $10.00 (bank will refuse it)");

  const base = process.env.APP_BASE_URL ?? API;
  console.log(`
Demo ready. The withdrawals settle, fail or come back over the next few seconds.
  Wallet:           ${base}/wallet/        (sign in as Alice, Bob or Carol)
  Admin dashboard:  ${base}/dashboard/     (token: local-admin-token, unless you set ADMIN_TOKEN)`);
} finally {
  await pool.end();
}
