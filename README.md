# Money Movement Platform

A fictional money movement platform built in stages, with a focus on one thing:
**staying correct when requests are duplicated, raced, or lost.**

This first stage is the core: accounts, an immutable double-entry ledger, and an
internal `POST /transfers` endpoint that is idempotent and safe under concurrency.
Stripe test payments, the outbox worker, a mock bank connector, and reconciliation
come next (see [Roadmap](#roadmap)). All money and accounts are fictional.

**Stack:** TypeScript, Node.js, Fastify, PostgreSQL 16, Vitest, Docker.

## Quick start

```bash
# Postgres (also creates a money_test database for the tests)
docker compose up -d db

npm install
cp .env.example .env
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_dev

npm run seed        # funding account + Alice ($50.00) + Bob; prints their ids
npm run dev         # API on http://localhost:3000

# tests run against a real Postgres (money_test), not mocks
DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_test npm test
```

Or run the API and database together with `docker compose up --build`.

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

`POST /transfers` responses:

| Status | Meaning |
|---|---|
| `201` | Transfer posted. |
| `422 insufficient_funds` | Transfer recorded as `rejected`; no ledger entries. |
| `422 idempotency_key_reused` | The key was already used with a different body. Nothing changed. |
| `422 currency_mismatch` | Account currency differs from the request. |
| `400` | Missing key or invalid body (e.g. `amount_cents: 10.5`). |
| `404` | An account does not exist. |

A replay returns the original status code and body, plus `Idempotent-Replayed: true`.

## Schema

```
accounts          id, name, currency, kind (user|system), balance_cents
transfers         id, idempotency_key UNIQUE, request_hash, from/to, amount_cents, status (posted|rejected)
ledger_entries    id, transfer_id, account_id, amount_cents (signed), currency   -- append-only
processed_events  (provider, event_id) PRIMARY KEY, event_type, payload          -- webhook inbox
```

See [`migrations/001_init.sql`](migrations/001_init.sql).

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
result. Money moves once.

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
- This only works because the transfer touches nothing but Postgres. Once a step
  calls Stripe or a bank (stage 3), a single transaction can't cover the side
  effect. That needs a recorded state machine with recovery points plus an
  outbox, so external calls are retried from durable state rather than from
  memory.

### Webhook deduplication (groundwork)

`processed_events` has a primary key of `(provider, event_id)`.
`recordEventOnce()` inserts with `ON CONFLICT DO NOTHING` and must be called
**inside the same transaction** that applies the event's effects. A duplicate
delivery is skipped. If applying the event crashes, the record rolls back with
the effects, so the provider's redelivery is processed instead of being lost.
Tests cover redelivery, 10 concurrent deliveries, and crash-then-redeliver.
Stage 1 wires this to Stripe webhooks.

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
| Same webhook twice? | `processed_events deduplicates external events` |

CI (GitHub Actions) runs the typecheck and the full suite against a Postgres 16 service container.

## Roadmap

1. ✅ **Internal transfers:** accounts, double-entry ledger, `POST /transfers`, idempotency, concurrency.
2. **Payments:** Stripe test Checkout, a verified webhook, and a deposit posted from the webhook (not from the success page).
3. **Reliability:** an outbox worker, retries with backoff, and webhook dedup wired to Stripe.
4. **Bank connector:** a mock provider with delayed success, failures, duplicate webhooks, and outages.
5. **Reconciliation:** compare the ledger against provider records, with an admin dashboard for unmatched items.
6. **Dashboard:** a small React UI for balances and history.
