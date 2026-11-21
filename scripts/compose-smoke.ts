// Smoke test for the one-command demo. Run it against a stack started with
// `docker compose up --build -d`, once the seed has finished:
//
//   docker compose run --rm seed npx tsx scripts/compose-smoke.ts
//
// It only talks HTTP, like a user would: it checks the seeded withdrawals
// play out, the core API refuses callers without the right credentials, a
// payout survives a lossy bank, a double-sent transfer moves money once, and
// reconciliation against the bank's statement comes out clean.
import { randomUUID } from "node:crypto";

const API = (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? "local-admin-token"}` };
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

interface Item {
  kind: string;
  object_id: string;
  title: string;
  state: "pending" | "settled" | "failed";
  status: string;
  status_label: string;
}

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function eventually<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = await get();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    last = await get();
  }
  check(what, done(last), last);
  return last;
}

const sessionFor = async (id: string) => ({
  authorization: `Bearer ${(await call("POST", "/me/session", {}, { account_id: id })).json.token}`,
});
const activity = async (auth: Record<string, string>) => (await call("GET", "/me/activity", auth)).json.data as Item[];
const payouts = (items: Item[]) =>
  Object.fromEntries(items.filter((i) => i.kind === "payout").map((i) => [i.title.slice(-4), i.status]));

console.log(`Smoke-testing the demo at ${API}`);

// --- It is up --------------------------------------------------------------
check("GET /health", (await call("GET", "/health")).status === 200);
for (const page of ["/wallet/", "/dashboard/"]) {
  const res = await call("GET", page);
  check(`${page} serves the app`, res.status === 200 && String(res.json).includes("<div id="), res.status);
}

const users = (await call("GET", "/me/demo-users")).json.data as { id: string; name: string }[];
const id = Object.fromEntries(users.map((u) => [u.name.toLowerCase(), u.id]));
check("the seed created Alice, Bob and Carol", Boolean(id.alice && id.bob && id.carol), users);
const alice = await sessionFor(id.alice);
const bob = await sessionFor(id.bob);

// --- The seeded withdrawals play out -------------------------------------
await eventually(
  "Alice's seeded withdrawals end paid out (••1111) and returned (••0005)",
  async () => payouts(await activity(alice)),
  (p) => p["1111"] === "succeeded" && p["0005"] === "returned",
);
await eventually(
  "Bob's seeded withdrawals end failed and refunded (••0002, ••0004)",
  async () => payouts(await activity(bob)),
  (p) => p["0002"] === "failed" && p["0004"] === "failed",
);

// --- The core API needs the right caller ---------------------------------
check("GET /accounts/:id with no token is 401", (await call("GET", `/accounts/${id.alice}`)).status === 401);
check("... with the operator token is 200", (await call("GET", `/accounts/${id.alice}`, ADMIN)).status === 200);
check("... as Alice, for her own account, is 200", (await call("GET", `/accounts/${id.alice}`, alice)).status === 200);
check("... as Bob, for Alice's account, is 404", (await call("GET", `/accounts/${id.alice}`, bob)).status === 404);
const before = (await call("GET", `/accounts/${id.alice}`, ADMIN)).json.balance_cents as number;
const steal = await call(
  "POST",
  "/transfers",
  { ...bob, "idempotency-key": randomUUID() },
  { from_account_id: id.alice, to_account_id: id.bob, amount_cents: 100, currency: "USD" },
);
check("Bob cannot send Alice's money (403)", steal.status === 403, steal.json);
check("/admin/summary with no token is 401", (await call("GET", "/admin/summary")).status === 401);

// --- The same transfer sent twice moves money once -----------------------
const key = randomUUID();
const transfer = { from_account_id: id.alice, to_account_id: id.bob, amount_cents: 100, currency: "USD" };
const first = await call("POST", "/transfers", { ...alice, "idempotency-key": key }, transfer);
const second = await call("POST", "/transfers", { ...alice, "idempotency-key": key }, transfer);
check(
  "a transfer sent twice with one Idempotency-Key: both 201, same id, second replayed",
  first.status === 201 && second.status === 201 && first.json.id === second.json.id && second.headers.get("idempotent-replayed") === "true",
  { first: first.status, second: second.status },
);
const afterTransfer = (await call("GET", `/accounts/${id.alice}`, ADMIN)).json.balance_cents as number;
check("... and Alice's balance went down by $1.00 once", afterTransfer === before - 100, { before, afterTransfer });

// --- A payout survives a lossy bank --------------------------------------
const chaos = await call("POST", "/me/demo/bank", alice, { loseResponses: 1, webhookCopies: 2 });
check("the mock bank accepts the chaos switches", chaos.status === 200, chaos.json);
const payout = await call(
  "POST",
  "/me/payouts",
  { ...alice, "idempotency-key": randomUUID() },
  { amount_cents: 200, bank_account_number: "000123451111" },
);
check("a withdrawal through a bank that loses its response is accepted", payout.status === 201, payout.json);
await eventually(
  "... and is paid out exactly once",
  async () => (await call("GET", `/payouts/${payout.json.item.object_id}`, ADMIN)).json.status,
  (s) => s === "succeeded",
);
await call("POST", "/me/demo/bank", alice, { loseResponses: 0, webhookCopies: 1 });
const afterPayout = (await call("GET", `/accounts/${id.alice}`, ADMIN)).json.balance_cents as number;
check("... and Alice's balance went down by $2.00 once", afterPayout === afterTransfer - 200, { afterTransfer, afterPayout });

// --- Reconciliation against the bank's statement is clean ---------------
const run = await call("POST", "/admin/reconciliation/runs", ADMIN, { source: "mock_bank", currency: "USD" });
check(
  "a reconciliation run against the bank completes with no open breaks and balanced totals",
  run.status === 201 &&
    run.json.status === "completed" &&
    run.json.open_breaks === 0 &&
    run.json.totals?.held?.balanced === true &&
    run.json.totals?.settled?.balanced === true,
  run.json,
);
const summary = (await call("GET", "/admin/summary", ADMIN)).json;
check("no stuck payouts and no dead outbox events", summary.stuck_payouts === 0 && summary.dead_events === 0, summary);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
