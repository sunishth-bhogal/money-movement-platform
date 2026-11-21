# Money Movement Platform

A fictional money movement platform built in stages, with a focus on one thing:
**staying correct when requests are duplicated, raced, or lost.**

So far: accounts, an immutable double-entry ledger, an internal `POST /transfers`
endpoint that is idempotent and safe under concurrency, deposits through
**Stripe Checkout in test mode**, credited only by a verified webhook, and a
**transactional outbox** with a worker that publishes every money movement with
retries and backoff, and **payouts to a mock bank** that is slow, fails, sends
duplicate webhooks, loses responses and has outages on purpose. Reconciliation
comes next (see [Roadmap](#roadmap)). All money and accounts are fictional, and Stripe is only
ever used in test mode.

**Stack:** TypeScript, Node.js, Fastify, PostgreSQL 16, Stripe (test mode), Vitest, Docker.

## Quick start

```bash
# Postgres (also creates a money_test database for the tests)
docker compose up -d db

npm install
cp .env.example .env
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_dev

npm run seed        # funding account + Alice ($50.00) + Bob; prints their ids
npm run dev         # API on http://localhost:3000
npm run worker      # outbox worker: prints events (or POSTs them to OUTBOX_WEBHOOK_URL),
                    # and sends payouts to the bank when BANK_API_URL is set
npm run mock-bank   # the fake bank on :4000 (needs BANK_WEBHOOK_SECRET, see .env.example)

# tests run against a real Postgres (money_test), not mocks
DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_test npm test
```

Or run the API, the worker, the mock bank and the database together with `docker compose up --build`
(add `--scale worker=3` to run several workers side by side).

The tests need no Stripe account: webhook signatures are generated with Stripe's
SDK against a throwaway secret, and the Checkout API is faked.

### Demo: add funds with Stripe Checkout (test mode)

You need a Stripe account in **test mode** and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```bash
# 1. Forward Stripe test events to the local API. It prints a whsec_... secret.
stripe listen --forward-to localhost:3000/webhooks/stripe

# 2. In .env (gitignored), set your test keys:
#    STRIPE_SECRET_KEY=sk_test_...      (the server refuses live keys)
#    STRIPE_WEBHOOK_SECRET=whsec_...    (from step 1)
npm run dev

# 3. Start a $25.00 deposit for Bob
curl -s -X POST localhost:3000/deposits \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: deposit-demo-1' \
  -d '{"account_id":"<bob>","amount_cents":2500,"currency":"USD"}'
```

Open the returned `checkout_url` and pay with the test card `4242 4242 4242 4242`
(any future date, any CVC). **Close the tab instead of waiting for the redirect.**
`stripe listen` shows `checkout.session.completed` being delivered, and
`GET /deposits/<id>` reports `succeeded`, with Bob's balance up by 2500. The
browser never had to come back. Run `stripe events resend <evt_id>` to redeliver
the event: the response says `"outcome":"duplicate"` and the balance does not change.

### Demo: a payout survives a lost response and duplicate webhooks

With the API, the worker and the mock bank running (`docker compose up --build`
does all three), make the bank lose its next response and send every webhook twice:

```bash
curl -s -X POST localhost:4000/_admin/behaviour -H 'content-type: application/json' \
  -d '{"loseResponses":1,"webhookCopies":2}'

curl -s -X POST localhost:3000/payouts \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: payout-demo-1' \
  -d '{"account_id":"<alice>","amount_cents":2000,"currency":"USD","bank_account_number":"000123451111"}'
```

The payout comes back `pending`, and Alice's balance is already down by 2000
(the money is on hold). The worker's first call to the bank "times out", though
the bank did create the payout. The retry sends the same idempotency key and
gets that payout back. A few seconds later the bank settles it and sends the
`payout.succeeded` webhook twice. `GET /payouts/<id>` says `succeeded`,
`GET localhost:4000/_admin/state` shows one payout at the bank, and the second
webhook was acknowledged as a duplicate.

The last four digits of `bank_account_number` pick the outcome: `0002` fails
after settlement, `0004` is refused at once, `0005` succeeds and is then
returned, anything else succeeds. `{"outage":true}` takes the bank down, and
`{"webhooksEnabled":false}` makes it stop telling us anything, which leaves the
reconciler to find out.

### Demo: the same transfer sent twice moves money once

```bash
curl -i -X POST localhost:3000/transfers \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 6f1c0a52-demo' \
  -d '{"from_account_id":"<alice>","to_account_id":"<bob>","amount_cents":1000,"currency":"USD"}'
```

Run it twice. Both responses are `201` with the same transfer id. The second
carries `Idempotent-Replayed: true`, and Alice's balance (`GET /accounts/<alice>`)
went from 5000 to 4000 exactly once.

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/accounts` | `{ name, currency }` creates a user account |
| `GET` | `/accounts/:id` | Includes `balance_cents` |
| `GET` | `/accounts/:id/entries` | Ledger history, newest first. `?limit=&before=<entry id>` |
| `POST` | `/transfers` | Requires an `Idempotency-Key` header. Body: `{ from_account_id, to_account_id, amount_cents, currency }` |
| `GET` | `/transfers/:id` | |
| `POST` | `/deposits` | Requires an `Idempotency-Key` header. Body: `{ account_id, amount_cents, currency }`. Returns a `pending` deposit with a Stripe `checkout_url`. Moves no money. |
| `GET` | `/deposits/:id` | Deposit status. Also the Checkout success/cancel page; visiting it changes nothing. |
| `POST` | `/payouts` | Requires an `Idempotency-Key` header. Body: `{ account_id, amount_cents, currency, bank_account_number }`. Holds the money and returns a `pending` payout (`201`), or `422 insufficient_funds` with a `rejected` one. The bank is called afterwards, by the worker. |
| `GET` | `/payouts/:id` | Payout status: `pending`, `submitted`, `succeeded`, `failed`, `returned` or `rejected`, plus any `discrepancy`. |
| `POST` | `/webhooks/bank` | Mock bank events. Requires a valid `Bank-Signature` (HMAC-SHA256). Same status codes as the Stripe webhook. |
| `POST` | `/webhooks/stripe` | Stripe events. Requires a valid `Stripe-Signature`. `400` if verification fails, `200` once processed (or a duplicate), `500` on an error so Stripe retries. |

`POST /transfers` responses:

| Status | Meaning |
|---|---|
| `201` | Transfer posted. |
| `422 insufficient_funds` | Transfer recorded as `rejected`; no ledger entries. |
| `422 idempotency_key_reused` | The key was already used with a different body. Nothing changed. |
| `422 currency_mismatch` | Account currency differs from the request. |
| `400` | Missing key or invalid body (e.g. `amount_cents: 10.5`). |
| `403 system_account_not_allowed` | Either account is a system account. Only internal code moves money out of those. |
| `404` | An account does not exist. |

A replay returns the original status code and body, plus `Idempotent-Replayed: true`.

## Schema

```
accounts          id, name, currency, kind (user|system), balance_cents
transfers         id, (idempotency_scope, idempotency_key) UNIQUE, request_hash, from/to, amount_cents, status (posted|rejected)
ledger_entries    id, transfer_id, account_id, amount_cents (signed), currency   -- append-only
processed_events  (provider, event_id) PRIMARY KEY, event_type, payload          -- webhook inbox
deposits          id, idempotency_key UNIQUE, account_id, amount_cents, status,
                  stripe_checkout_session_id UNIQUE, transfer_id UNIQUE           -- Stripe Checkout state
outbox            id, event_id UNIQUE, event_type, aggregate_type/id, payload,
                  status (pending|published|dead), attempts, next_attempt_at, claim_token
payouts           id, idempotency_key UNIQUE, account_id, amount_cents, bank_account_number, status,
                  provider_payout_id UNIQUE, hold/settle/reverse/return_transfer_id, discrepancy
```

See [`migrations/`](migrations/).

## Design notes

### Money is integers

Amounts are `BIGINT` cents everywhere: in the database, in TypeScript, and over
the API. `10.5` is rejected with a 400, not rounded. Floats cannot represent most
decimal amounts exactly, and silently rounding someone's money is a bug.

### Double-entry, append-only ledger

Every posted transfer writes two `ledger_entries`: `-amount` on the source and
`+amount` on the destination. The database enforces the rules, so a bug in
application code cannot break them:

- **Balanced:** a deferred constraint trigger checks at `COMMIT` that each
  transfer's entries sum to zero. A code path that writes only one leg fails.
- **Immutable:** triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on
  `ledger_entries`. Mistakes are fixed with new, reversing entries, so history
  is never rewritten.
- **Balance is derived:** `accounts.balance_cents` is a cache of
  `SUM(ledger_entries.amount_cents)`. Only the insert trigger on
  `ledger_entries` changes it, in the same transaction as the entry. Application
  code never writes a balance. `checkLedgerInvariants()` recomputes every
  balance from the ledger, and the test suite runs it after every scenario.

Why cache the balance at all? A transfer needs to lock *something* and read the
current balance cheaply. One account row gives a single lock target and an O(1)
read, while the ledger stays the source of truth.

`system` accounts (today, a funding account standing in for Stripe) may go
negative, which is how money enters the closed system. `user` accounts may not.

### Concurrency: can two simultaneous transfers overspend an account?

No. Inside one transaction, `createTransfer` does this
([`src/ledger/transfers.ts`](src/ledger/transfers.ts)):

1. `SELECT ... FROM accounts WHERE id IN (from, to) ORDER BY id FOR NO KEY UPDATE`
2. Check the balance **while holding the lock**.
3. Insert the transfer and both ledger entries, then commit, which releases the lock.

A second transfer from the same account blocks at step 1 until the first
commits, then reads the updated balance. Check-then-write is safe because nobody
else can write in between.

- **Lock order prevents deadlocks.** A→B and B→A running at the same time would
  deadlock if each locked its source first. Locking both rows in id order means
  every transaction acquires locks in the same global order. A test fires 40
  opposite-direction transfers at once, and another runs a ring A→B→C→A.
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** It is the weakest row lock that still
  serialises balance changes. Unlike `FOR UPDATE`, it doesn't block the
  `FOR KEY SHARE` locks that foreign-key checks take, so unrelated inserts that
  merely reference an account aren't held up.
- **Why not `SERIALIZABLE`?** It would also be correct, but it resolves conflicts by
  aborting transactions, which pushes retries into every caller and degrades badly
  on a hot account. Explicit row locks under `READ COMMITTED` make contention
  queue rather than fail, and make the locking visible in the code.
  `withTransaction` still retries on `40001`/`40P01` as a safety net. That is
  safe only because the transaction has no side effects outside Postgres.
- **Defence in depth.** `CHECK (kind = 'system' OR balance_cents >= 0)` means
  that even a broken implementation cannot commit an overdraft. A test runs a
  deliberately naive, lock-free implementation: both racing debits pass the
  application check, and Postgres rejects one with `check_violation`.

The test "20 simultaneous $10 transfers from a $50 account" asserts exactly 5
succeed and 15 are rejected. If you remove the `FOR NO KEY UPDATE` line, that
test and both deadlock tests fail.

### Idempotency: what if the database commits but the response is lost?

The client retries with the same `Idempotency-Key` and gets back the original
result. Money moves once. And whether or not the client ever retries, exactly
one outbox event announces the transfer (see [the outbox](#the-transactional-outbox)).

The response can be lost in two different places, and
[`test/reliability.test.ts`](test/reliability.test.ts) tests both against a real
HTTP server and Postgres:

1. **After COMMIT, on the way to the client.** The server built its `201` but
   the connection dropped (a proxy timeout, a phone losing signal). The client
   sees a network error. The test destroys the socket in an `onSend` hook, which
   runs after the transaction committed, then checks the money moved, retries,
   and gets `201` with `Idempotent-Replayed: true`, the same transfer id, one
   transfer row, unchanged balances and one `transfer.posted` event.
2. **During COMMIT, on the way back from Postgres.** COMMIT succeeded, but the
   acknowledgement never reached the server, so *the server itself* does not
   know the outcome. It answers `500`, which is honest: it must not claim
   failure for something that may have happened. The test runs COMMIT for real
   and then reports a dropped connection. The retry (on a healthy instance)
   finds the committed row and replays it.

In both cases the client cannot tell whether money moved, and does not need to:
the retry is safe either way. A `500` from this endpoint always means "unknown,
retry with the same key", never "definitely did not happen".

- **One transaction is the whole operation.** The transfer row, which *is* the
  idempotency record, commits in the same transaction as the ledger entries. So
  "money moved but the key wasn't saved", or the reverse, cannot happen. There
  is no `in_progress` state to get stuck, because nothing is visible until
  commit.
- **The unique index decides concurrent duplicates.** 25 parallel requests with one
  key all reach the `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`.
  Postgres makes the later ones wait for the first. If it commits, they see the
  conflict, write nothing, and return the stored transfer. If it rolls back, one
  of them proceeds. A fast-path `SELECT` by key handles sequential retries
  without taking account locks.
- **Same key, different body → 422.** The request is fingerprinted
  (`sha256` of the canonical body) and stored with the key. Reusing a key for a
  different transfer is a client bug, and we refuse to guess which one was
  meant.
- **Outcomes are replayed, including rejections.** A request that was rejected
  for insufficient funds is replayed as the same 422, even if the account has
  been funded since. Retrying the same key must return the same answer, and a
  new attempt needs a new key. This matches how Stripe handles idempotent requests.
- **Validation errors are not stored.** A 400/404 happens before anything is
  written, so the key stays unused and the client can fix the request and retry.

**Known limits, deliberately deferred:**

- Keys are global. Once there is auth, they should be scoped per client
  (`UNIQUE (client_id, idempotency_key)`).
- Keys never expire. Stripe keeps them for 24h. Here the transfer row doubles as
  the record, so keeping it forever costs nothing extra.
- This only works because the transfer touches nothing but Postgres. Anything
  that must happen *outside* Postgres because of a transfer goes through the
  outbox, which is retried from durable state rather than from memory. Calls to
  Stripe that happen *before* the money moves (opening Checkout) use the
  recorded deposit state machine instead.

**Gaps closed in stage 3:**

- **Client keys could collide with internal ones.** The deposit webhook posts
  its ledger transfer under the key `deposit:<deposit id>`, and the deposit id is
  in the client's own `POST /deposits` response. Keys were one global namespace,
  so a client could send `deposit:<id>` as its *own* `Idempotency-Key` first
  (even a rejected transfer stores the key). The webhook would then hit "key
  reused with a different body", return `500` on every Stripe retry, and the
  deposit could never be credited. Keys now have a scope:
  `UNIQUE (idempotency_scope, idempotency_key)`, with `api` for client keys and
  `system` for keys built by our code. Migration `003` moves existing deposit
  transfers to `system`.
- **The public API could move money out of system accounts.** System accounts
  may go negative, so `POST /transfers` from the Stripe clearing account would
  have minted money. `api`-scoped transfers now require both accounts to be
  `user` accounts (`403 system_account_not_allowed`). Internal code (the
  webhook, the seed script) uses the `system` scope.

### The transactional outbox

**The problem.** When money moves, other systems need to hear about it: a
notification service, a partner's webhook, analytics, later the bank connector.
The obvious code is "commit, then publish", and it has two failure modes. If the
process dies between the two, the transfer happened and nobody is ever told. If
you publish first and the commit then fails, you announced a transfer that does
not exist. No amount of `try`/`catch` fixes this, because a crash skips both.

**The fix.** Don't publish from the request at all. Write the event as a row in
the `outbox` table **inside the same transaction** as the ledger change
([`createTransferInTx`](src/ledger/transfers.ts) and the deposit webhook do
this). The event now exists if and only if the change committed. A separate
worker reads the table and does the publishing, after commit, with retries.

Events written today: `transfer.posted`, `transfer.rejected`, and
`deposit.<status>` (`succeeded`, `processing`, `failed`, `expired`,
`requires_review`). A credited deposit writes both `transfer.posted` and
`deposit.succeeded` in its one transaction. A replayed request writes nothing.

**The worker** ([`src/outbox/worker.ts`](src/outbox/worker.ts), `npm run worker`)
polls in three short, separate statements, and never holds a transaction open
during the network call. (A transaction open across a slow HTTP call holds row
locks and a pooled connection for as long as the slowest destination takes.)

1. **Claim.** `SELECT ... WHERE status = 'pending' AND next_attempt_at <= now()
   ... FOR UPDATE SKIP LOCKED`, then in the same statement bump `attempts`, set a
   fresh `claim_token`, and push `next_attempt_at` forward by the lease (60s by
   default). Commit.
2. **Publish**, outside any transaction, with a timeout shorter than the lease.
3. **Complete.** Mark `published`, or schedule a retry, or mark `dead`, but only
   `WHERE claim_token = <ours>`.

**Running many workers.** `FOR UPDATE SKIP LOCKED` makes concurrent workers step
over rows another worker is claiming at that instant, rather than queueing
behind its lock or claiming the row twice. Once a claim commits, the row's
`next_attempt_at` is in the future, so no other worker sees it as due. Workers
share nothing but Postgres, so you can run any number of them, in any number of
processes. A test runs 6 workers against 300 events and checks each is delivered
exactly once; removing `SKIP LOCKED` makes it fail with duplicate deliveries.

**What if a worker crashes mid-publish?** There's no `in_progress` status to get
stuck in: the claim *is* a lease, stored in `next_attempt_at`. If the worker
dies, the lease runs out and the row is simply due again, and another worker
picks it up. Two cases, both tested:

- **Crash before publishing.** The next worker publishes it. One delivery.
- **Crash after the destination accepted it, but before writing `published`.**
  From the database's side this looks exactly like the first case, so the event
  is published again. This is the outbox's own version of "committed but the
  response was lost", and it can't be avoided: no system can atomically update
  Postgres *and* someone else's server. So **delivery is at-least-once**, and
  every event carries a stable `event_id` (sent as the `Idempotency-Key` header
  by the HTTP publisher). Consumers deduplicate on it, exactly like our own
  webhook does with Stripe's event ids. The test asserts two deliveries, one
  applied effect.

**Fencing.** A worker can stall rather than die (a long GC pause, a frozen VM),
lose its lease, and wake up while another worker is mid-publish. Completing
requires the `claim_token` the worker was given at claim time, and a new claim
issues a new token, so the stale worker's late "failed" or "published" matches
nothing and is dropped. The publish timeout must be shorter than the lease (the
constructor refuses otherwise), so a *healthy* worker never loses a row it is
still working on.

**Retries and backoff.** A failed publish is retried after an exponential delay
with jitter: `window = min(maxDelay, base × 2^(attempt−1))`, and the delay is a
random point in `[window/2, window]`. The fixed half guarantees a real pause; the
random half stops a crowd of events that failed at the same moment (a
downstream outage) from all retrying in lockstep and knocking it over again.
Defaults: base 1s, cap 10 min, 10 attempts.

**Retry exhaustion.** After `maxAttempts`, the event goes to `dead` with its
`last_error` kept, and is never tried again on its own. Three things lead
there: running out of attempts; a `PermanentPublishError` from the publisher
(the HTTP publisher raises it for 4xx other than 408 and 429, since resending the
same bad request can't help); or a worker crashing on the final attempt (the
lease expires and the row is retired instead of being tried an 11th time). A
crash counts as an attempt, so an event that crashes the worker every time ("a
poison message") can't loop forever. `requeueDeadEvent()` puts a dead event back
with a fresh budget once someone has fixed the cause.

**Known limits, deliberately deferred:**

- **No ordering guarantee.** Parallel workers, retries and backoff mean
  `transfer.posted` for one transfer can arrive after a later one. Consumers
  that need order should use `aggregate_id` plus the payload's timestamps, or
  we'd need per-aggregate sequencing, which costs throughput.
- **Polling, not push.** An idle worker polls every second. `LISTEN/NOTIFY`
  would cut latency, but polling is needed anyway as the fallback, so it comes
  first.
- **Published rows are kept forever.** At real volume, a job would delete or
  archive published rows after a retention window. The partial index means
  they don't slow the worker down meanwhile.
- **Outgoing HTTP events are not signed yet.** A receiver can't yet verify they
  came from us. That would be an HMAC header, like Stripe's.
- **Dead events need a person.** There is no admin endpoint or alert for them
  yet. That belongs with the reconciliation dashboard.

### Payouts: the mock bank connector

Code: [`src/bank/`](src/bank/) (the fake bank and the client for it) and
[`src/payouts/`](src/payouts/) (our side). A payout sends money *out* of the
closed system, through a bank we can only reach over the network, which can be
slow, wrong, silent or down.

**The ledger never waits for the bank.** `POST /payouts` makes no network call.
In one transaction it records the payout, **holds** the money with a transfer
from the user to a `Payouts in flight` system account, and writes a
`payout.submit` event to the outbox. The usual row lock and funds check apply,
so ten simultaneous $10 payouts from a $50 account hold exactly five. Because
the hold and the instruction to pay commit together, money is never held for a
payout that nobody will send, and a payout is never sent without its money held.

```
user ──hold──► Payouts in flight ──settle──► Bank payouts          succeeded
                       └──────────reverse──► user                  failed
               Bank payouts ──return──► user                       returned (after success)
```

Each step is a `system`-scoped transfer with the key `payout:<id>:<step>`, so
posting a step twice is a no-op. The schema adds the rule that matters most:
held money either leaves for the bank or comes back to the user, never both
(`CHECK (settle_transfer_id IS NULL OR reverse_transfer_id IS NULL)`). The test
suite checks after every test that `Payouts in flight` holds exactly the open
payouts' money and `Bank payouts` exactly the succeeded ones.

**Sending goes through the outbox worker.** The worker routes `payout.submit`
events to the bank connector ([`submitter.ts`](src/payouts/submitter.ts)) and
everything else to the usual destination, so payouts get leases, retries with
backoff, fencing and dead-lettering for free. Every attempt sends the same
idempotency key, `payout:<id>`. The connector sorts the bank's answers into three kinds:

| The bank says | It means | We do |
|---|---|---|
| `201`/`200` with the payout | it has it (new, or a replay of an earlier attempt) | record it: `submitted`, or straight to its final status if the bank already finished |
| `422` (e.g. invalid account number) | definitely refused, and holds no money for it | `failed`, reverse the hold, done (not retried) |
| timeout, connection error, `5xx`, `429` | **unknown**: it may or may not have acted | change nothing; throw, so the worker retries with the same key |

**Webhooks** (`POST /webhooks/bank`) are signed like Stripe's
(`t=<ts>,v1=<HMAC-SHA256 of "<ts>.<raw body>">`, 5 minutes' tolerance) and
deduplicated by `processed_events` in the same transaction as their effects, so
a duplicate delivery is acknowledged and skipped.

#### How does our system recover when the provider's state differs from ours?

The bank is the source of truth for whether money left. Our database is the
source of truth for what we *told the user*. They drift apart whenever a
message is lost: a response that never came back, a webhook that never
arrived, a retry budget that ran out during an outage. The design has three parts:

1. **One way to apply the bank's word, whichever way it arrives.** The response
   to our submit, a webhook and a status lookup all go through
   [`applyProviderState`](src/payouts/payouts.ts). It moves our payout *towards
   the bank's state*, rather than reacting to "this message", so the three can
   arrive in any order and any number of times:

   | ours \ bank | processing | succeeded | failed | returned |
   |---|---|---|---|---|
   | pending | → submitted | → succeeded (settle) | → failed (reverse) | settle, then return |
   | submitted | no change | → succeeded (settle) | → failed (reverse) | settle, then return |
   | succeeded | no change | no change | **discrepancy** | → returned (return) |
   | failed | no change | **discrepancy** | no change | **discrepancy** |
   | returned | no change | no change | **discrepancy** | no change |

   An older status (a slow lookup, a late webhook) is stale news and never moves
   a payout backwards. A *contradiction*, where the bank says failed after
   saying succeeded, or reports a different amount or payout id, is recorded in
   `discrepancy` and emits a `payout.discrepancy` event, and **no money moves**.
   Code can't safely claw back a reversal the user may already have spent, so a
   person decides (stage 5's dashboard lists these).

2. **Ask the bank, by idempotency key.** The [reconciler](src/payouts/reconcile.ts),
   run by the worker every 30s, looks up open payouts that have been quiet for a
   minute. The key is computed from our payout id, so the lookup works even if
   we never learned the bank's id (the response that carried it was lost).
   Whatever the bank says goes through the same `applyProviderState`.

3. **Never infer failure from silence.** If the bank has no record of a pending
   payout, that does **not** mean it failed: a request may still be in flight,
   and returning the money to the user while the bank may still pay it out
   would pay it twice. Instead: if the submit event is `dead`, the reconciler
   puts it back in the queue (the same key makes resending safe); if a retry is
   still scheduled, it leaves it alone. The only things that mark a payout
   `failed` are the bank saying so, or a `422` refusal. A payout the bank
   *acknowledged* and then has no record of is a discrepancy.

What that looks like in each case (all in [`test/payouts.test.ts`](test/payouts.test.ts)):

| What happened | Bank | Us, before | How it converges |
|---|---|---|---|
| Response lost after the bank created the payout | processing | pending | The retry sends the same key and gets the same payout back. One payout at the bank. |
| ...then an outage outlasts every retry, and webhooks are lost too | succeeded | pending, submit event `dead` | The reconciler looks it up by key and settles it. Not sent again. |
| Same, but the bank failed it | failed | submitted | The reconciler reverses the hold. |
| Outage from the start: the bank never got it | (nothing) | pending, submit event `dead` | The reconciler re-queues the submit. It is sent once and settles. |
| Outage, but a retry is still scheduled | (nothing) | pending | Left alone. Not failed on a guess. |
| The webhook arrives before our own response | succeeded | pending | The webhook settles it; the late retry sees it's done and stops. |
| `returned` arrives before `succeeded` | returned | submitted | Settle, then return, once each, in order. The late `succeeded` is no change. |
| The bank contradicts itself | failed | succeeded | Discrepancy recorded, no money moves. |
| The bank has a different amount | 2500 | 2000 | Discrepancy recorded, still held. |
| The bank lost a payout it acknowledged | (nothing) | submitted | Discrepancy recorded, still held. |

A chaos test pushes 30 payouts across all four outcomes through lost responses,
an outage, duplicate webhooks and a stretch with no webhooks at all, and checks
that each ends in exactly the bank's state, the bank holds 30 payouts (none
sent twice), and every balance is right.

**The mock bank** ([`src/bank/mockBank.ts`](src/bank/mockBank.ts)) keeps its own
records, which our database can't see, and talks to us only through API
responses and webhooks. It runs in-process in tests (with an injectable clock)
or as its own HTTP server (`npm run mock-bank`), and one test drives the whole
path over real HTTP. Its outcomes are chosen by account number (like Stripe's
test cards), and its misbehaviour is set at runtime: `outage`, `loseResponses`
(process the request, then drop the response), `latencyMs`, `settleAfterMs`
(delayed success), `webhookCopies` (duplicates), `webhooksEnabled`. It retries
webhooks our endpoint didn't accept.

**Known limits, deliberately deferred:**

- **No cancellation.** Real payout APIs often allow cancelling a payout before
  it is sent. That would give "the bank never got it" a third option besides
  waiting and resending.
- **Payouts don't expire.** One that the bank never receives and that someone
  never re-queues stays `pending` with its money held. That is safe, but
  stage 5's dashboard should show old pending payouts.
- **Discrepancies need a person.** There is no admin action to resolve one yet.
- **The mock bank's state is in memory.** Restarting it forgets every payout,
  which the reconciler will (correctly) report as discrepancies.

### Webhook deduplication

`processed_events` has a primary key of `(provider, event_id)`.
`recordEventOnce()` inserts with `ON CONFLICT DO NOTHING` and must be called
**inside the same transaction** that applies the event's effects. A duplicate
delivery is skipped. If applying the event crashes, the record rolls back with
the effects, so the provider's redelivery is processed instead of being lost.
Tests cover redelivery, 10 concurrent deliveries, and crash-then-redeliver.

### Deposits: Stripe Checkout and a verified webhook

Code: [`src/payments/`](src/payments/). Test mode only: the server refuses to
start with a key that isn't `sk_test_`/`rk_test_`, and the webhook rejects any
event with `livemode: true`.

**The success page credits nothing.** A browser redirect proves nothing (anyone
can type the URL), and many users close the tab after paying, so it may never
arrive. Money moves only when Stripe tells the server directly, through a signed
webhook. `GET /deposits/:id` (the success URL) just shows the current status, so
a client shows "pending" until the webhook lands, usually within seconds.

**The deposit is a state machine, recorded in Postgres:**

```
created ─► pending ─┬─(paid)─────────────────────────────► succeeded
                    ├─(async method) ► processing ─┬─────► succeeded
                    │                              └─────► failed
                    ├─(session expired)──────────────────► expired
                    └─(paid amount ≠ requested)──────────► requires_review
```

**Creating a deposit is two steps, because a Stripe call can't be inside a
database transaction.** First, a `created` row is committed under the client's
`Idempotency-Key`. Then Stripe is called with its own idempotency key,
`deposit-checkout:<deposit id>`, and the session is saved as `pending`. If the
Stripe call fails or the process dies between the two, the row stays `created`.
A retry with the same key repeats only the Stripe call, and Stripe's idempotency
returns the same session, so the user never gets two Checkout pages for one click.
The deposit id goes to Stripe as `client_reference_id`, so the webhook can find
the deposit even if the session id was never saved.

**Verifying the webhook.** Stripe signs `timestamp.raw_body` with HMAC-SHA256
using the endpoint's secret. The route keeps the body as the raw bytes (in its
own Fastify scope, so other routes still parse JSON normally), and
`stripe.webhooks.constructEvent` checks the signature and rejects timestamps
more than 5 minutes old, which stops replays of a captured request. A failed
check returns `400` before anything is written. Re-serialising parsed JSON would
change the bytes and break verification, which is why the raw body matters.

**Posting exactly once.** One transaction records the event in
`processed_events`, locks the deposit row, moves its status, and posts a normal
double-entry transfer from a `Stripe clearing` system account to the user. It
either all commits or none of it does. Three layers stop a double credit:

1. **Same event twice** (Stripe retries on any timeout, so this is routine): the
   `processed_events` primary key. A duplicate gets `200` with
   `outcome: "duplicate"`, so Stripe stops retrying.
2. **Different events for one payment** (e.g. `checkout.session.completed` and
   then `async_payment_succeeded`): the deposit row is locked `FOR UPDATE` and
   only a non-final deposit is credited.
3. **Backstops in the schema:** the ledger transfer's idempotency key is
   `deposit:<id>`, `deposits.transfer_id` is unique, and a `CHECK` requires
   `status = 'succeeded'` exactly when `transfer_id` is set.

If processing throws, the route returns `500` and the rollback leaves no trace,
so Stripe's next retry starts clean. Lock order is deposit row, then account
rows, and nothing locks them the other way round, so this can't deadlock with
transfers.

**What we refuse to guess.** If a paid session's amount or currency differs from
the deposit, the deposit goes to `requires_review` and nothing is credited.
Events for unknown deposits, for a session we didn't create, or of types we
don't handle are recorded and acknowledged (`outcome: "ignored"`).

**The clearing account.** `Stripe clearing (USD)` is a `system` account created
on first use. It goes negative by the amount Stripe holds for us, which is what
reconciliation (stage 5) will compare against Stripe's balance.

**Known limits, deliberately deferred:**

- Refunds, disputes and chargebacks are not handled yet. They will be reversing
  transfers out of the user account.
- Handling is synchronous inside the webhook request. `processed_events` is
  already the inbox (dedup in the same transaction as the effects), and
  anything that must reach the outside world after a credit goes through the
  outbox. Splitting "record and acknowledge" from "apply" only pays off once
  applying gets slow, which it isn't yet.
- If webhooks stop arriving altogether (endpoint misconfigured, outage), deposits
  stay `pending`. A sweeper that asks Stripe about old `pending` sessions belongs
  with reconciliation.

## Tests

The tests run against real PostgreSQL. Concurrency bugs don't show up against mocks.

| Hard question | Test |
|---|---|
| Same request sent twice? | `a retry after a lost response returns the original transfer and moves money once` |
| Same request sent 25× at once? | `25 concurrent requests with the same key create exactly one transfer` |
| Two transfers overspend? | `20 simultaneous $10 transfers from a $50 account: exactly 5 succeed` |
| Deadlocks? | `transfers in opposite directions ... do not deadlock`, `a ring of concurrent transfers` |
| What if the app code is wrong? | `without row locks, a naive check-then-write would overspend; the CHECK constraint stops it`, `refuses to commit entries that do not sum to zero` |
| Can history be rewritten? | `refuses UPDATE, DELETE and TRUNCATE` |
| Same webhook twice? | `processed_events deduplicates external events`, `the same event delivered twice` |
| Same webhook 10× at once? | `the same event delivered 10 times concurrently` |
| Two different events for one payment? | `two different events for the same payment (completed, then async_payment_succeeded)` |
| Forged or tampered webhook? | `rejects a bad signature and records nothing`, `rejects a body that was changed after signing`, `... a replayed old one` |
| User closes the browser after paying? | `a user who pays and closes the browser is still credited, by the webhook` |
| Does the success page move money? | `landing on the success page changes nothing` |
| Stripe times out while creating Checkout? | `if Stripe fails, the deposit stays 'created' and a retry reuses the same Stripe idempotency key` |
| Stripe charged a different amount? | `a paid amount that differs from the deposit is held for review, not credited` |
| **DB commits, connection drops before the response?** | `the connection drops after commit: the retry returns the original transfer, and money moves once` |
| **COMMIT succeeds, its acknowledgement is lost?** | `COMMIT succeeds but its acknowledgement is lost: the server answers 500, and the retry finds the committed transfer` |
| Client never retries: does anyone hear about the transfer? | `even if the client never retries, downstream still hears about the transfer exactly once` |
| Event without the change, or change without the event? | `if the transaction rolls back, neither the transfer nor its event exists`, `a replayed request does not write a second event` |
| Worker crashes before publishing? | `crash after claiming, before publishing: the lease expires and another worker publishes it` |
| Worker crashes after publishing, before recording it? | `crash after publishing, before recording it: the event is delivered again, and the consumer applies it once` |
| A stalled worker wakes up late? | `a worker that stalls past its lease cannot overwrite the worker that took over (fencing)` |
| Many workers at once? | `6 workers draining 300 events at once deliver each event exactly once` |
| Flaky destination? | `with a flaky destination (30% of calls fail), every event is still accepted exactly once` |
| Retries run out? | `retries with growing delays, then marks the event dead after maxAttempts`, `a crash on the final attempt retires the event as dead` |
| Destination hangs? | `a publish that hangs is timed out and retried, without waiting for the lease` |
| A client squats an internal idempotency key? | `a client that sends deposit:<id> as its own Idempotency-Key cannot block the deposit from being credited` |
| A client moves money out of a system account? | `the public API cannot move money out of a system account` |
| Two payouts overspend? | `10 simultaneous $10 payouts from a $50 account: exactly 5 are held, 5 rejected` |
| Bank fails or refuses a payout? | `the bank fails it later: the hold is reversed ...`, `the bank refuses it outright (422) ...` |
| Duplicate bank webhooks? | `every webhook delivered 3 times: applied once ...`, `the same webhook delivered 10 times at once is applied once` |
| Bank's response lost? | `the bank's response is lost: the retry sends the same key, and the bank pays out once` |
| **Timeout, then the bank actually paid it out?** | `timeout, then the bank actually paid it out, and no webhook ever came: the status lookup settles it` |
| Bank outage outlasts every retry? | `an outage outlasts every retry and the bank never got it: the reconciler re-queues it, and it is paid once` |
| Bank silent: do we fail it on a guess? | `the bank hasn't got it yet but a retry is still scheduled: the reconciler leaves it alone` |
| Webhooks out of order? | `the webhook beats our own response ...`, `out of order: 'returned' arrives before 'succeeded' ...` |
| Bank contradicts itself or us? | `the bank contradicts itself ...`, `the bank reports a different amount ...`, `the bank acknowledged a payout and then lost it ...` |
| All of it at once? | `chaos: 30 payouts through lost responses, an outage, duplicate webhooks and no webhooks ...` |

CI (GitHub Actions) runs the typecheck and the full suite against a Postgres 16 service container.

## Roadmap

1. ✅ **Internal transfers:** accounts, double-entry ledger, `POST /transfers`, idempotency, concurrency.
2. ✅ **Payments:** Stripe test Checkout, a verified webhook, and a deposit posted from the webhook (not from the success page).
3. ✅ **Reliability:** a transactional outbox, a concurrent-safe worker with retries and backoff, and idempotency-key scopes.
4. ✅ **Bank connector:** payouts to a mock bank with delayed success, failures, returns, lost responses, duplicate webhooks and outages, and a reconciler that recovers when the bank and we disagree.
5. **Reconciliation:** compare the ledger against provider records, with an admin dashboard for unmatched items.
6. **Dashboard:** a small React UI for balances and history.
