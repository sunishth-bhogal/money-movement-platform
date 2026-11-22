// Seeds the demo (`npm run demo:seed`, or the `seed` service in
// docker-compose.yml, which runs it for you):
//
//   - two event organizers with a history the organizer portal can explain:
//     a past event that was paid out and then charged back, a second event
//     whose payout was cut to cover that chargeback, and an upcoming
//     co-hosted event (60/40) that is on sale, for the live outage demo;
//   - three wallet users (Alice, Bob, Carol) with every state the wallet shows.
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

const ADMIN = process.env.ADMIN_TOKEN ?? "local-admin-token";
const DAY = 24 * 3600_000;

/** Found by name on a re-run: organizers and events have no idempotency key of their own. */
async function demoOrganizer(name: string, bank: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM organizers WHERE name = $1 ORDER BY created_at LIMIT 1", [name]);
  if (rows[0]) return rows[0].id;
  return (await api<{ id: string }>(ADMIN, "POST", "/organizers", { name, currency: "USD", bank_account_number: bank })).json.id;
}

async function demoEvent(body: { name: string; venue: string; starts_in_days: number; advance_bps?: number; organizers: { organizer_id: string; share_bps: number }[]; ticket_types: { name: string; price_cents: number; capacity: number }[] }) {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM events WHERE name = $1 ORDER BY created_at LIMIT 1", [body.name]);
  let id = rows[0]?.id;
  if (!id) {
    const starts = Date.now() + body.starts_in_days * DAY;
    id = (await api<{ id: string }>(ADMIN, "POST", "/events", {
      name: body.name,
      venue: body.venue,
      currency: "USD",
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(starts + 3 * 3600_000).toISOString(),
      advance_bps: body.advance_bps ?? 0,
      organizers: body.organizers,
      ticket_types: body.ticket_types,
    })).json.id;
  }
  const types = await pool.query<{ id: string; name: string }>("SELECT id, name FROM ticket_types WHERE event_id = $1", [id]);
  return { id, type: (name: string) => types.rows.find((t) => t.name === name)!.id };
}

async function seedOrganizers() {
  console.log("Seeding event organizers:");
  const northside = await demoOrganizer("Northside Sports Club", "000123451111");
  const lakeview = await demoOrganizer("Lakeview Live", "000123452222");
  const session = async (id: string) => (await api<{ token: string }>(null, "POST", "/organizer/session", { organizer_id: id })).json.token;
  const tok = { northside: await session(northside), lakeview: await session(lakeview) };
  const say = (what: string) => console.log(`  ${what}`);

  type Order = { order: { id: string; status: string; amount_cents: number }; replayed: boolean };
  const buy = async (eventId: string, key: string, buyer: string, items: { ticket_type_id: string; quantity: number }[]) => {
    const r = (await api<Order>(null, "POST", `/box-office/events/${eventId}/orders`, { buyer_name: buyer, buyer_email: `${buyer.split(" ")[0].toLowerCase()}@example.com`, items }, `demo-seed:${key}`)).json;
    if (r.order.status === "created" || r.order.status === "pending") {
      await api(null, "POST", `/box-office/orders/${r.order.id}/demo-checkout`, { outcome: "pay" });
    }
    say(`${buyer.padEnd(14)} buys ${items.reduce((n, i) => n + i.quantity, 0)} ticket(s)${r.replayed ? "  (replayed: already seeded)" : ""}`);
    return r.order.id;
  };
  const finish = async (token: string, eventId: string, name: string) => {
    const { rows } = await pool.query<{ released_at: Date | null }>("SELECT released_at FROM events WHERE id = $1", [eventId]);
    if (!rows[0].released_at) await api(token, "POST", `/organizer/demo/events/${eventId}/finish`, {});
    say(`${name} has happened: proceeds released and paid out${rows[0].released_at ? "  (already seeded)" : ""}`);
  };

  // 1. A past fun run: sold, one partial refund, paid out, then a chargeback after the payout.
  const run = await demoEvent({
    name: "Spring 5K Fun Run",
    venue: "Northside Park",
    starts_in_days: 7,
    organizers: [{ organizer_id: northside, share_bps: 10_000 }],
    ticket_types: [{ name: "Runner", price_cents: 3_000, capacity: 200 }, { name: "Kids dash", price_cents: 1_000, capacity: 100 }],
  });
  const runOrders = [
    await buy(run.id, "run:1", "Priya Shah", [{ ticket_type_id: run.type("Runner"), quantity: 2 }, { ticket_type_id: run.type("Kids dash"), quantity: 1 }]),
    await buy(run.id, "run:2", "Marcus Reed", [{ ticket_type_id: run.type("Runner"), quantity: 1 }]),
    await buy(run.id, "run:3", "Elena Ortiz", [{ ticket_type_id: run.type("Runner"), quantity: 3 }]),
  ];
  const { rows: kids } = await pool.query<{ id: string }>(
    "SELECT t.id FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.order_id = $1 AND tt.name = 'Kids dash' LIMIT 1",
    [runOrders[0]],
  );
  await api(tok.northside, "POST", `/organizer/orders/${runOrders[0]}/refunds`, { ticket_id: kids[0].id, amount_cents: 500, reason: "organizer_goodwill", note: "Kids dash shortened" }, "demo-seed:run:refund:1");
  say("Northside refunds half of a kids-dash ticket");
  await finish(tok.northside, run.id, "Spring 5K Fun Run");

  // The chargeback lands after the payout left: Northside now owes it.
  const disputed = await pool.query("SELECT 1 FROM disputes WHERE order_id = $1", [runOrders[1]]);
  if (!disputed.rowCount) {
    await api(tok.northside, "POST", `/organizer/demo/orders/${runOrders[1]}/dispute`, { outcome: "open" });
    await api(tok.northside, "POST", `/organizer/demo/orders/${runOrders[1]}/dispute`, { outcome: "lost" });
  }
  say("Marcus Reed's bank charges his ticket back after the payout (lost)");

  // 2. Quiz night: its payout is cut by what the chargeback left owing.
  const quiz = await demoEvent({
    name: "Northside Quiz Night",
    venue: "Clubhouse",
    starts_in_days: 10,
    organizers: [{ organizer_id: northside, share_bps: 10_000 }],
    ticket_types: [{ name: "Team of 4", price_cents: 4_000, capacity: 30 }],
  });
  await buy(quiz.id, "quiz:1", "Dev Patel", [{ ticket_type_id: quiz.type("Team of 4"), quantity: 1 }]);
  await buy(quiz.id, "quiz:2", "Hannah Kim", [{ ticket_type_id: quiz.type("Team of 4"), quantity: 1 }]);
  await finish(tok.northside, quiz.id, "Northside Quiz Night");

  // 3. Upcoming and co-hosted 60/40, half paid early on request: the live demo cancels it.
  const concert = await demoEvent({
    name: "Harbor Lights Concert",
    venue: "Lakeview Pier",
    starts_in_days: 14,
    advance_bps: 5_000,
    organizers: [{ organizer_id: lakeview, share_bps: 6_000 }, { organizer_id: northside, share_bps: 4_000 }],
    ticket_types: [{ name: "General", price_cents: 4_500, capacity: 300 }, { name: "VIP", price_cents: 12_000, capacity: 40 }],
  });
  await buy(concert.id, "concert:1", "Sam Turner", [{ ticket_type_id: concert.type("General"), quantity: 2 }]);
  await buy(concert.id, "concert:2", "Aisha Bello", [{ ticket_type_id: concert.type("VIP"), quantity: 1 }]);
  await buy(concert.id, "concert:3", "Leo Martin", [{ ticket_type_id: concert.type("General"), quantity: 4 }]);
  say("Harbor Lights Concert is on sale (Lakeview 60%, Northside 40%)");
}

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

  if (config.deposits === "demo_checkout") await seedOrganizers();
  else console.log("  (no demo checkout, so no ticket sales; set DEMO_MODE=true without a Stripe key for them)");

  const base = process.env.APP_BASE_URL ?? API;
  console.log(`
Demo ready. The withdrawals and organizer payouts settle over the next few seconds.
  Organizer portal: ${base}/portal/        (sign in as Northside Sports Club or Lakeview Live)
  Wallet:           ${base}/wallet/        (sign in as Alice, Bob or Carol)
  Admin dashboard:  ${base}/dashboard/     (token: local-admin-token, unless you set ADMIN_TOKEN)`);
} finally {
  await pool.end();
}
