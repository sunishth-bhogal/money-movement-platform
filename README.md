# Money Movement Platform

**Ticket sales and payouts for small event organizers**, on top of a money
movement platform built in stages with a focus on one thing: **staying correct
when requests are duplicated, raced, or lost.**

The product: a sports club or a small promoter sells tickets through Stripe
Checkout (test mode). The platform takes its fee, holds the proceeds until the
event has happened (so refunds can be paid from them), splits them between
co-hosts, and pays each organizer through a (mock) bank. When an event is
cancelled, a buyer asks for a partial refund, or a card is charged back after
the organizer was paid, the ledger records who owes what, and the organizer's
**payout statement** explains every payout to the cent, down to the ticket:
*"you sold $X, here are the fees, refunds and adjustments, here is why your
payout is $Y."* See [Ticketing and organizer payouts](#ticketing-and-organizer-payouts).

Underneath: accounts, an immutable double-entry ledger, an internal `POST /transfers`
endpoint that is idempotent and safe under concurrency, deposits through
**Stripe Checkout in test mode**, credited only by a verified webhook, and a
**transactional outbox** with a worker that publishes every money movement with
retries and backoff, **payouts to a mock bank** that is slow, fails, sends
duplicate webhooks, loses responses and has outages on purpose, and
**reconciliation** of the ledger against both providers' own records, with a
small React admin dashboard for what only a person can decide, and a **user
wallet** where a user sees their balances and full history, adds funds, sends
money and withdraws, with every pending, settled and failed state visible. All
money and accounts are fictional, and Stripe is only ever used in test mode.

**Stack:** TypeScript, Node.js, Fastify, PostgreSQL 16, Stripe (test mode), React + Vite (organizer portal, wallet and admin dashboard), Vitest, Docker.

**Start here:** [architecture diagrams](docs/ARCHITECTURE.md) ·
[the event-cancellation demo](docs/demo/README.md#the-organizer-story-cancel-an-event-while-the-bank-is-down)
(sell tickets, cancel during a bank outage, refund, obligation, recovery, audit trail) ·
[failure-scenario demo](docs/demo/README.md) (duplicate transfer, duplicate
webhook, lost bank response, as a recording and a script) ·
[interview talking points](docs/INTERVIEW.md).

## One-command demo

```bash
docker compose up --build      # or: npm run demo
```

This starts Postgres, the API, the outbox worker and the mock bank, then seeds
two event organizers and three wallet users with a history (the `seed` service
prints a summary and exits). Open:

- **Organizer portal:** <http://localhost:3000/portal/>. The *Box office* tab
  sells tickets; the *Organizer* tab signs in as **Northside Sports Club** or
  **Lakeview Live** (a demo: no password) and shows their payouts, held
  proceeds and events.
- **Wallet:** <http://localhost:3000/wallet/>. Pick a user: sign-in is a demo,
  no password. Each tab keeps its own sign-in, so Alice and Bob can be open side by side.
- **Admin dashboard:** <http://localhost:3000/dashboard/>, token `local-admin-token`.

No Stripe account is needed: with `DEMO_MODE=true` (the compose default) and no
`STRIPE_SECRET_KEY`, **Add funds** opens a demo checkout page instead of Stripe
(see [the wallet](#the-wallet-user-dashboard)). Set test-mode Stripe keys and it
uses real Stripe Checkout instead.

Things to try in the organizer portal:

| Try | What you see |
|---|---|
| Sign in as **Northside Sports Club** → *Payouts* | Two paid payouts. The $172.35 one: $190.00 sold, fees, a $5.00 partial refund. The $32.00 one: the Quiz Night's $75.00, minus a $30.00 chargeback (plus a $15.00 fee) on the fun run that had already been paid out. Each line opens to the tickets and orders behind it; each order opens to its ledger trace. *Adds up to the cent* is checked, not asserted. |
| *Held until after your events* | Northside's 40% of the co-hosted Harbor Lights Concert, held until after it happens. Lakeview sees its 60%. |
| *Box office* → buy a ticket → *Pay by card* | The order is paid by a signed Stripe event through the real webhook, and the organizer's held balance goes up by the price minus the fee. *Pay, and Stripe delivers the webhook twice* credits it once. |
| *Events* → an event → *refund* on one ticket, for part of its price | The refund comes out of held money, the platform returns its share of the fee, and the refund settles when Stripe confirms. |
| *Demo controls* → **Bank connector down**, then *Take an early payout* on Harbor Lights, then *Cancel event…* | The early payout waits; every buyer is refunded at once; what was paid early becomes *You owe*. Switch the bank back on and the early payout is sent exactly once. |
| *Demo: the event happens now* on an event | Demo only: the event "happens", its money is released and paid out by the schedule. |
| An order → *Demo: chargeback* → *lost* | After payout: the organizer owes it, and the next statement says so. |

Or run the whole story as a checked script: `bash docs/demo/event-cancellation.sh`
(see [the demo](docs/demo/README.md#the-organizer-story-cancel-an-event-while-the-bank-is-down)).

Things to try in the wallet:

| Try | What you see |
|---|---|
| Right after seeding | Four withdrawals go from *Pending* to *Settled* (••1111), *Failed, refunded* (••0002 and ••0004) and *Returned* (••0005) as the worker and the mock bank play them out. Changed rows flash. |
| **Send money**, then *Double-click test* (or just double-click **Send**) | Two requests, one transfer: "Sent 2 times with the same Idempotency-Key, and it moved money once." One row in the activity. |
| Send more than you have | A *Failed* row for the sender ("Not enough money"), nothing for the recipient, no money moved. |
| **Add funds** → *Pay, and deliver the webhook twice* | The deposit is *Pending* until the signed webhook arrives, then credited once; the second delivery is a duplicate. |
| **Add funds** → *Pay by bank debit, which then fails* / *Abandon* | *Payment processing* then *Payment failed*, or *Checkout abandoned*. Nothing credited. |
| **Withdraw** to *Closed account ••0002* | *Pending* with the money on hold, then *Bank failed it, refunded*. Open the row: a hold and a release in the ledger, never an edit. |
| *Make the bank misbehave* → **Bank outage**, then withdraw | Stays *Pending* while the worker retries with backoff; switch the outage off and it settles. |
| **Lose the next response** / **Send every webhook twice** | Still exactly one payout at the bank and one settlement. |
| **Stop sending webhooks**, then withdraw | Stays *Bank is processing*. The worker's status check (every 30s by default) or **Run reconciliation** in the admin dashboard finds it paid. |

Running the seed again (`docker compose run --rm seed`) changes nothing: every
request it makes has a fixed idempotency key, so each one is answered from the
first run. The portal and the wallet can also be run in development with
`npm run portal` (Vite on :5175) and `npm run wallet`
(Vite on :5174, proxying `/me` to the API) after `npm run dev`; seed with
`npm run demo:seed` (needs the API running, with `WALLET_SESSION_SECRET` set).

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
npm run dashboard   # the admin dashboard on :5173 (needs ADMIN_TOKEN on the API)
npm run wallet      # the user wallet on :5174 (needs WALLET_SESSION_SECRET on the API)

# tests run against a real Postgres (money_test), not mocks
DATABASE_URL=postgres://postgres:postgres@localhost:5432/money_test npm test
```

Or run the API, the worker, the mock bank and the database together with `docker compose up --build`
(add `--scale worker=3` to run several workers side by side). The dashboard is then at
<http://localhost:3000/dashboard/>; sign in with any name and the token `local-admin-token`.

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
  -H 'Authorization: Bearer local-admin-token' \
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
  -H 'Authorization: Bearer local-admin-token' \
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

### Demo: reconciliation finds what nobody told us, and a person settles the rest

With everything running (`docker compose up --build`), make the bank lose its
next response and stop sending webhooks, so nobody tells us how the payout ends:

```bash
curl -s -X POST localhost:4000/_admin/behaviour -H 'content-type: application/json' \
  -d '{"loseResponses":1,"webhooksEnabled":false}'
curl -s -X POST localhost:3000/payouts -H 'content-type: application/json' \
  -H 'Authorization: Bearer local-admin-token' \
  -H 'Idempotency-Key: recon-demo-1' \
  -d '{"account_id":"<alice>","amount_cents":700,"currency":"USD","bank_account_number":"000123451111"}'
```

A few seconds later the bank has paid it out, and `GET /payouts/<id>` still
says `submitted`. Open the dashboard and press **Run reconciliation**: the run
reads the bank's statement, finds the payout paid, settles it (one `settle`
transfer, through the same code a webhook uses), and lists it as
auto-resolved. The proof column says the run *ties out*. (The test suite also
covers the harder version, where an outage outlasts every retry and the payout
is still `pending` with its submit event dead.)

Now make the bank change its story about a payout that already succeeded:

```bash
curl -s -X POST localhost:4000/_admin/tamper -H 'content-type: application/json' \
  -d '{"idempotency_key":"payout:<payout id>","status":"failed"}'
```

Run again. This one is an open break ("The bank says failed, we recorded
succeeded"), because code never reverses a final payout on its own. Click the
payout key to see every transfer behind it, then resolve it ("Provider is
right: settle with the user's account", with a note). The refund is a new
ledger transfer, linked to your decision in the audit log, and the next run is
clean. The same API is under `/admin` (see below).

### Demo: the same transfer sent twice moves money once

```bash
curl -i -X POST localhost:3000/transfers \
  -H 'Authorization: Bearer local-admin-token' \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 6f1c0a52-demo' \
  -d '{"from_account_id":"<alice>","to_account_id":"<bob>","amount_cents":1000,"currency":"USD"}'
```

Run it twice. Both responses are `201` with the same transfer id. The second
carries `Idempotent-Replayed: true`, and Alice's balance (`GET /accounts/<alice>`)
went from 5000 to 4000 exactly once.

## API

Every route below except the webhooks and `/health` needs a caller:
`Authorization: Bearer <ADMIN_TOKEN>` for an operator, who may act on any user
account, or a wallet session token from `POST /me/session` for a user, who may
only see and move their own money (`403` for someone else's account in a
request body, `404` for someone else's transfer, deposit or payout). No valid
token is a `401`; with neither `ADMIN_TOKEN` nor `WALLET_SESSION_SECRET` set,
`503`. Users' `Idempotency-Key`s are namespaced by account, like the wallet's.
`POST /accounts` is operator-only. `GET /deposits/:id` without any
`Authorization` header (the browser coming back from Checkout) answers only
`{ id, status }`.

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

The wallet API (`/me`) is what the user wallet calls. Every route except the
first three needs `Authorization: Bearer <token from POST /me/session>` (`401`
without a valid one, `503` if `WALLET_SESSION_SECRET` is unset), and acts only
on that user's account:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/me/config` | What the server has switched on: `deposits` is `stripe_test`, `demo_checkout` or `disabled`. |
| `GET` | `/me/demo-users` | The user accounts, for the demo sign-in screen. |
| `POST` | `/me/session` | `{ account_id }` → `{ token, expires_at, account }`. Demo sign-in: no password. |
| `GET` | `/me` | `available_cents`, `on_hold_cents` (withdrawals not yet paid out), `incoming_cents` (deposits awaiting payment). |
| `GET` | `/me/activity` | The feed, newest first: one row per deposit, withdrawal, transfer or adjustment, each `pending`, `settled` or `failed`. `?limit=&before=<next_cursor>` |
| `GET` | `/me/statement` | Every ledger posting on the account with the balance after it. `?limit=&before=<entry id>` |
| `GET` | `/me/payees` | Other users you can send to. |
| `POST` | `/me/transfers` | `Idempotency-Key` required. `{ to_account_id, amount_cents }`. `201 { item, replayed }`, or `422` with a `failed` item. |
| `POST` | `/me/deposits` | `Idempotency-Key` required. `{ amount_cents }`. `201 { item, replayed, checkout_url }`. Moves no money. |
| `GET` | `/me/deposits/:id` | One of your deposits, as a feed row. |
| `POST` | `/me/payouts` | `Idempotency-Key` required. `{ amount_cents, bank_account_number }`. Holds the money: `201` with a `pending` item, or `422` with a `failed` one. |
| `POST` | `/me/deposits/:id/demo-checkout` | `DEMO_MODE` only. `{ outcome: "pay" \| "pay_duplicate_webhook" \| "bank_debit_fails" \| "abandon" }`. Sends the matching signed Stripe events to `/webhooks/stripe`. |
| `GET` / `POST` | `/me/demo/bank` | `DEMO_MODE` only. The mock bank's `outage`, `loseResponses`, `webhookCopies` and `webhooksEnabled` switches. |

The admin API needs `Authorization: Bearer <ADMIN_TOKEN>` (`401` without it, `503` if `ADMIN_TOKEN` is unset):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/summary` | Counts for the dashboard, control account balances, latest run per source and currency. |
| `POST` | `/admin/reconciliation/runs` | `{ source: "mock_bank" \| "stripe", currency }`. Runs now. `201` with the run, `502` with a `failed` run if the provider's statement could not be read, `409 run_in_progress`. |
| `GET` | `/admin/reconciliation/runs`, `/admin/reconciliation/runs/:id` | Runs, and one run with its items. |
| `GET` | `/admin/reconciliation/breaks` | Open and in-transit items from the latest runs. `?include_resolved=true` adds resolved ones. |
| `POST` | `/admin/reconciliation/items/:id/resolve` | `{ action: "accept_provider" \| "accept_ours", cause, counterparty?: "user" \| "platform", note, resolved_by }`. `cause` is why they disagreed: `missed_notification`, `provider_error`, `our_error`, `timing`, `fraud_suspected` or `other`. `201`; the same request again replays it. `409` for `stale_item`, `ledger_changed`, `already_resolved`; `422 insufficient_funds`. |
| `GET` | `/admin/reconciliation/trace?break_key=payout:<id>` | Every ledger transfer, run and decision behind one item. |
| `GET` | `/admin/resolutions` | The audit log. |
| `GET` | `/admin/payouts/flagged` | Payouts the bank contradicted, and payouts held for over an hour. |
| `POST` | `/admin/payouts/:id/acknowledge` | `{ note, resolved_by }`. Records that a person looked at a flag. Moves no money. |
| `GET` / `POST` | `/admin/outbox/dead`, `/admin/outbox/:event_id/requeue` | Dead events, and putting one back in the queue. |

The ticketing API. Operators (`ADMIN_TOKEN`) create organizers and events;
buyers use the public box office; organizers sign in to `/organizer`
(`POST /organizer/session`, a demo sign-in like the wallet's) and see and act
only on their own events and orders (`404` for anyone else's).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/organizers` | Operator. `{ name, currency, bank_account_number }`. Creates the organizer and their two accounts (held, available). |
| `POST` | `/events` | Operator. `{ name, venue?, currency, starts_at, ends_at, fee_bps?, fee_fixed_cents?, hold_hours?, advance_bps?, organizers: [{ organizer_id, share_bps }], ticket_types: [{ name, price_cents, capacity }] }`. Shares must total 100%. Defaults: 5% + $0.50 a ticket, held 48 hours after the event, no early payout. |
| `GET` | `/box-office/events` | Events on sale, with seats left. |
| `POST` | `/box-office/events/:id/orders` | `Idempotency-Key` required. `{ buyer_name, buyer_email, items: [{ ticket_type_id, quantity }] }`. Reserves the seats (`409 sold_out` otherwise) and opens Stripe Checkout. Moves no money. |
| `GET` | `/box-office/orders/:id` | The buyer's order: tickets, refunds, and the event's status. |
| `POST` | `/box-office/orders/:id/demo-checkout` | `DEMO_MODE` only. Like the wallet's: signed Stripe events through `/webhooks/stripe`. |
| `GET` | `/organizer/` | The home page: balances (`held`, `available`, `in_flight`, `owed_by_organizer`), the next payout's statement so far, held events, and every payout's statement. |
| `GET` | `/organizer/events`, `/organizer/events/:id`, `/organizer/orders/:id` | Events with totals; one event's orders and tickets; one order's ledger trace. |
| `POST` | `/organizer/orders/:id/refunds` | `Idempotency-Key` required. `{ ticket_id?, amount_cents?, reason, note? }`. Without `ticket_id`, everything left on the order; with it, that ticket, or part of it. |
| `POST` | `/organizer/events/:id/cancel` | `{ reason }`. Stops sales and refunds every paid order in full. Again: changes nothing. |
| `POST` | `/organizer/events/:id/advance` | An early payout of up to the event's `advance_bps` of what is held, once, before the event. |
| `POST` | `/organizer/demo/...` | `DEMO_MODE` only: `events/:id/finish`, `orders/:id/dispute` (`open`, `won`, `lost`), `run-schedule`, and the bank's `outage` switch. |
| `GET` | `/admin/organizers`, `/admin/organizers/:id/statement` | Every organizer's balances; one organizer's statements. |
| `POST` | `/admin/organizers/:id/adjustments` | `Idempotency-Key` required. `{ amount_cents, cause, note, decided_by, event_id?, order_id?, dispute_id? }`. `cause` is `organizer_repaid`, `debt_written_off`, `goodwill_credit` or `correction`. A ledger transfer against *organizer adjustments*, on the organizer's next statement. |
| `GET` | `/admin/orders/:id/trace` | Every ledger transfer behind one order: sale, fees, refunds, disputes. |
| `POST` | `/admin/payout-schedule/run` | Release finished events and pay organizers now (the worker does it every `PAYOUT_SCHEDULE_EVERY_MS`, default 30s). |
| `GET` | `/admin/events/invariants` | Cross-checks every order, ticket, refund and dispute against the ledger. `{ ok, problems }`. |

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
reconciliation_runs                 id, source, currency, status, counts, totals (the proof)    -- final once finished
reconciliation_items                run_id, break_key, classification, outcome, positions,
                                    auto_action, auto_transfer_ids, fingerprint               -- append-only
reconciliation_resolutions          item_id UNIQUE | payout_id, action, counterparty, note,
                                    resolved_by, fingerprint                                  -- append-only
reconciliation_resolution_postings  resolution_id, transfer_id UNIQUE                         -- append-only

-- ticketing (migration 007)
organizers            id, name, currency, bank_account_number, held_account_id, available_account_id
events                id, name, starts_at, ends_at, fee_bps, fee_fixed_cents, hold_hours, advance_bps,
                      status (on_sale|cancelled), cancel_reason, released_at
event_organizers      event_id, organizer_id, share_bps                   -- shares total 10000
ticket_types          id, event_id, name, price_cents, capacity
orders                id, idempotency_key UNIQUE, event_id, buyer, amount_cents, fee_cents, status,
                      stripe_checkout_session_id, stripe_payment_intent_id, sale_shares
tickets               id, order_id, ticket_type_id, price_cents, fee_cents, status, refunded_cents
refunds               id, idempotency_key UNIQUE, order_id, ticket_id?, amount_cents, reason,
                      status (pending|succeeded|requires_review), shares, stripe_refund_id
disputes              id, stripe_dispute_id UNIQUE, order_id, amount_cents, fee_cents, status (open|won|lost), shares
organizer_adjustments id, idempotency_key UNIQUE, organizer_id, amount_cents, cause, note, decided_by, transfer_id
organizer_postings    transfer_id PRIMARY KEY, organizer_id, kind, memo            -- append-only; why each organizer entry exists
payouts               + organizer_id, event_id
reconciliation_resolutions  + cause
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

- Keys are global on the raw API (the wallet scopes its keys per user, see
  [the wallet](#the-wallet-user-dashboard)). Once there is auth, they should be scoped per client
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
- **Dead events need a person.** The admin dashboard lists them and can
  re-queue one. There is no alert yet.

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
   person decides, from the reconciliation dashboard.

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
  never re-queues stays `pending` with its money held. That is safe, and the
  dashboard lists payouts held for over an hour.
- **Discrepancies need a person.** Since stage 5, the dashboard shows them, and
  reconciliation turns any that leave money in the wrong place into breaks
  with a resolution (see below).
- **The mock bank's state is in memory.** Restarting it forgets every payout,
  which the reconciler will (correctly) report as discrepancies.

### Reconciliation: how do we prove where every dollar went?

Code: [`src/reconciliation/`](src/reconciliation/), the admin API in
[`src/admin/routes.ts`](src/admin/routes.ts), the dashboard in
[`dashboard/`](dashboard/).

Webhooks, responses and status lookups tell us what happened one message at a
time, and stage 4 showed every way those messages get lost. Reconciliation
stops trusting the messages and compares **books with books**: the providers'
own records (the mock bank's statement, `GET /payouts`, paginated; Stripe's
Checkout Sessions, `checkout.sessions.list`) against our ledger.

**The ledger side is the ledger, not our status columns.** Each source has
control accounts: `Payouts in flight` and `Bank payouts` for the bank,
`Stripe clearing` for Stripe. Every transfer that touches them belongs to an
item: by its key (`payout:<id>:hold`, `payout:<id>:settle`, `deposit:<id>`, ...)
or because a person's resolution posted it. So for each payout or deposit the
run knows, from the entries themselves, how much the ledger says is *in
flight* and how much has *left* (or, for Stripe, been *collected*). The provider's
record says the same two things (`processing` → in flight; `succeeded` → left;
`failed`/`returned` → neither; a paid session → collected). Equal: matched.
Different: a break.

| Break | Means |
|---|---|
| `missing_at_provider` | We have money against it; the provider has no record. |
| `missing_in_ledger` | The provider has a record; we have nothing for it. |
| `amount_mismatch` | Both have it, for different amounts. |
| `status_mismatch` | Same amount, but the money is somewhere else (e.g. "in flight" for us, "paid out" at the bank). |

Comparing money rather than labels matters: a payout that we recorded as
`returned` and the bank calls `failed` has no money out of place, so it isn't a
break (it stays a flag on the payout, which a person can acknowledge). A
payout we call `succeeded` that the bank calls `failed` has 20.00 sitting in
`Bank payouts` that never left, and it is.

**The proof.** Every run stores, per dimension (in flight, settled), the
ledger's control account total, the provider's total, the sum of what the
remaining items disagree by, and anything on the control accounts that belongs
to no item. A run *ties out* when

```
ledger total − provider total = Σ (ledger − provider) over the remaining items,   and   unexplained = 0
```

So every cent of difference between our books and the provider's has a named
item with a classification, and there is no money on a control account that we
cannot attribute to a payout, a deposit or a person's decision. The tests
assert this after every scenario, and the dashboard shows it per run.

**What a run fixes by itself, and nothing else.** An item still open on our
side (a `pending`/`submitted` payout, a deposit not yet credited) where the
provider's record says how it ended: the run applies it through the same
function a webhook uses (`applyProviderState`, `applyCheckoutSessionEvent`), so
it can only move money forward, and only once. That resolves the uncertain
states from stage 4 without a person:

| Uncertain state | What the run sees | What it does |
|---|---|---|
| Response lost, outage outlasted every retry, no webhook | ours `pending`, bank `succeeded` | settles it (one `settle` transfer) |
| Same, bank still processing | ours `pending` (held), bank `processing` (in flight) | nothing: same money, same place, matched |
| Bank never got it, submit event dead | ours `pending`, no bank record | in transit, not a break; re-queues the submit (same key) |
| Stripe charged the card, webhook lost | deposit `pending`, session `paid` | credits it once; a late webhook is `already_final` |
| Stripe collected a different amount | deposit `requires_review`, session `paid` 24.00 | nothing: an open break for a person |

A provider contradicting a *final* state of ours is never fixed by code. It is
an open break.

Runs start from the dashboard, the API, or the worker, which runs one per
configured provider every `RECONCILE_EVERY_MS` (5 minutes by default, for the
currencies in `RECONCILE_CURRENCIES`).

**A partial statement is never used.** The statement is read page by page, and
if any page fails the run is stored as `failed` and nothing is compared or
changed. Otherwise every payout on the missing pages would look "missing at
the bank". One run per source and currency at a time (an advisory lock); a
second gets `409`.

**What a person decides, and how it is recorded.** From the dashboard (or
`POST /admin/reconciliation/items/:id/resolve`):

- **Provider is right** (`accept_provider`). The run computes the transfers
  that move the ledger to the provider's position: first between our own
  control accounts (in flight → paid out), then the rest to or from a
  counterparty the person picks: the **user** (their money never left, so it
  goes back; or it did, so it is taken back, refused with `insufficient_funds`
  if they have spent it), or the **platform**, through a `Reconciliation
  adjustments` account that records the business's loss or gain.
- **Our ledger is right** (`accept_ours`): no money moves. Later runs show the
  same disagreement as `acknowledged`, still counted in the proof. If anything
  about it changes (the fingerprint covers statuses, amounts and positions), it
  comes back as open.

Every resolution is a row in an append-only table with the person's name and
note, and every transfer it posts is a normal, balanced, system-scoped ledger
transfer keyed `recon:<resolution id>:<n>`, linked to it. The original
postings are never touched: a refund after a wrong settle is a new transfer
next to the settle, and the trace view shows both. Runs are final once
finished, and items, resolutions and their links reject `UPDATE` and `DELETE`
in the database, like `ledger_entries`.

**Resolving safely.** A resolution is one transaction that takes the item's
lock (shared with the run's own fixes) and the payout or deposit row lock
(shared with webhooks), then re-reads the ledger. If the money moved since the
run looked (a webhook arrived), it is refused with `ledger_changed`: run again
and decide on what is true now. Only items from the latest run can be
resolved (`stale_item` otherwise), and one resolution per item is a unique
constraint, so ten clicks on "Resolve" post one correction.

**Known limits, deliberately deferred:**

- **Runs compare all history** for a source and currency. At volume they would
  cover a statement period (a day), with a margin for records that straddle it.
- **One shared admin token.** `resolved_by` is what the operator typed. Real
  operator identity (SSO, roles, a second approver for large corrections)
  comes with auth.
- **Statements are fetched whole, in memory.** Fine for a mock bank and a test
  Stripe account; a real one would stream into a staging table.
- **The mock bank's records are in memory.** Restarting it makes every payout
  "missing at the provider", which is what reconciliation should say.

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
on first use. It goes negative by the amount Stripe has collected for us, which
reconciliation compares, session by session, with Stripe's own records.

**Known limits, deliberately deferred:**

- Refunds, disputes and chargebacks are not handled yet. They will be reversing
  transfers out of the user account.
- Handling is synchronous inside the webhook request. `processed_events` is
  already the inbox (dedup in the same transaction as the effects), and
  anything that must reach the outside world after a credit goes through the
  outbox. Splitting "record and acknowledge" from "apply" only pays off once
  applying gets slow, which it isn't yet.
- If webhooks stop arriving altogether (endpoint misconfigured, outage), deposits
  stay `pending` until the next reconciliation run, which finds the paid
  session in Stripe's records and credits it through the webhook's own code.
  Sessions that expired without payment are left `pending` (no money is at
  stake); syncing that label is a small follow-up.

### Ticketing and organizer payouts

The product layer (`src/events/`, migration `007`) is built from the same parts
as everything else: ledger transfers with idempotency keys, Stripe Checkout and
its verified webhook, the outbox, the bank connector, reconciliation. Nothing
in it updates a balance; every movement is a transfer.

**Where an organizer's money sits.** Each organizer has two ledger accounts:

```
Stripe clearing ──sale──► held ──fee──► Platform fees
                           │ └─refund─► Refunds in flight ──► Refunded through Stripe
                           └─release (after the event)─► available ──payout─► Payouts in flight ──► Bank
```

- **held** (`organizer_held`): proceeds of events that have not happened yet.
  Refunds come out of it first. It can never go negative: the same database
  `CHECK` that protects a user's balance.
- **available** (`organizer`): released proceeds, ready to pay out. It *may* go
  negative. A refund or chargeback after the money was paid out means the
  organizer owes the platform, and that is a real state of the business, so the
  ledger shows it instead of hiding it. The next payout is smaller by exactly
  that amount, with the reason on the statement, or a person records how it was
  settled (below).

**A sale.** The order reserves seats under the event's row lock (`409 sold_out`
for the loser of a race for the last seat) and opens Checkout; no money moves.
The verified `checkout.session.completed` webhook posts, per organizer, the
sale (`order:<id>:sale:<organizer>`, clearing → held) and the fee
(`order:<id>:fee:<organizer>`, held → platform fees). A co-hosted event splits
each sale by `share_bps` with a largest-remainder allocation in integer cents,
so the shares always add up to the order exactly, and the fee follows each
organizer's gross. A duplicate webhook finds those keys already used.

**Refunds and cancellation.** A refund is a whole order, one ticket, or part of
one ticket. It is split across the organizers in proportion to what each still
has from that order, taken from held money first and then from available, and
the platform returns the same fraction of its fee (all of what is left of it on
the final refund, so the fee never goes negative and rounding never leaves a
cent behind). The money goes to *refunds in flight*; the outbox's
`refund.submit` asks Stripe (key `refund:<id>`) and the refund settles when
Stripe confirms. A refund Stripe fails goes to `requires_review`: no money is
moved back on a guess. Cancelling an event stops sales and refunds every paid
order in full in the same transaction; a payment that arrives after the
cancellation is recorded and refunded at once.

**Chargebacks.** `charge.dispute.created` takes the disputed amount and
Stripe's $15 fee from the organizers (held first, then available) into
*disputes*. A dispute won brings the amount back; the fee stays lost, as at
Stripe. If the dispute is larger than what is left of the order, the platform
absorbs the excess.

**Payouts.** The worker's payout schedule releases each event `hold_hours`
after it ends (`event:<id>:release:<organizer>`) and pays the organizer's whole
available balance through the existing bank connector
(`event:<id>:payout:<organizer>`). The amount is read under the account's row
lock, so a refund racing the payout is either in it or after it. An event can
offer an **early payout** (`advance_bps`): up to that share of what is held,
once per organizer, before the event starts. That is what makes cancelling
interesting: what was paid early can no longer be refunded from held money, so
it becomes the organizer's obligation.

**Every entry has a reason.** Each transfer that touches an organizer account
writes an `organizer_postings` row (kind, memo, the event, order, refund,
dispute or payout) in the same transaction, and a deferred constraint trigger
refuses to commit an organizer ledger entry without one. The payout statement
is built from the ledger entries joined to those rows, not from the order
tables, so it cannot leave anything out:

- each payout's window runs from the previous payout's hold to this one;
- lines are grouped by event (released after the event, paid early, or "after
  it was paid out" for refunds and chargebacks that came later), then by kind,
  and each line opens to the tickets and orders behind it;
- a release or an advance is expanded into the sales, fees and refunds it
  carried, with "Already paid out early" and "Held back until after the event"
  where a release follows an advance;
- `balanced` checks that the opening balance plus every line equals the payout,
  and the summary sentences are generated from the same lines.

**Decisions, not silent fixes.** An organizer who owes money and repays it, or
a debt the platform writes off, is an **adjustment**: a transfer against
*organizer adjustments* with a `cause` (`organizer_repaid`, `debt_written_off`,
`goodwill_credit`, `correction`), a note and who decided it, which shows on the
organizer's next statement. Reconciliation works the same way: a contradiction
is a break for a person, and their resolution now records **why** the books
and the provider disagreed (`missed_notification`, `provider_error`,
`our_error`, `timing`, `fraud_suspected`, `other`) next to what they decided.
Stripe reconciliation now also pairs ticket orders with their Checkout sessions
(`order:<id>`), and settles a paid order whose webhook never came.

**What the portal shows.** The *Payouts* tab is the explanation page: the next
payout so far, what is held for each upcoming event, and every payout's
statement with an *adds up to the cent* check. Each order opens to its ledger
trace (`/organizer/orders/:id`). Organizers see only their own share of a
co-hosted event.

### The wallet (user dashboard)

The wallet ([`wallet/`](wallet/), served at `/wallet/`) is a React app over a
small user-facing API ([`src/wallet/`](src/wallet/)). It adds no new way to
move money: transfers, deposits and withdrawals go through the same
`createTransfer`, `createDeposit` and `createPayout` as the rest of the API, so
every guarantee above applies unchanged. What it adds:

- **Demo sign-in, real authorisation.** You pick a user and get an
  HMAC-signed token naming their account (12 hours). There are no passwords,
  which is fine for fictional money, but no `/me` route takes an account id
  to act on: the money always comes from the account in the token, and other
  users' deposits answer `404`. Real auth would replace how the token is
  issued, not how it is checked.
- **Idempotency keys come from the browser, one per intention.** A form makes
  a key the first time it sends and keeps it while its fields are unchanged
  ([`wallet/src/idempotent.ts`](wallet/src/idempotent.ts)). A double-click, a
  second press after a slow answer, or a retry after "no answer from the
  server" all reuse it, so they are answered from the first request. Editing a
  field or pressing *Start a new one* is a new intention and a new key. When
  the outcome is unknown (network error or `5xx`) the wallet says so, and says
  pressing again is safe.
- **Keys are scoped per user.** The server stores wallet keys as
  `wallet:<account id>:<key>`, so two users sending the same key get two
  operations, and nobody can replay or block someone else's request by
  guessing its key. (This closes, for the wallet, the "keys are global" limit
  noted under idempotency.)
- **One feed row per thing, with honest states.** A withdrawal is one row
  whose state follows the payout: *pending* while held, *settled* when the bank
  paid it, *failed* if the bank failed or returned it. Each row has
  `balance_effect_cents` (what it does to the balance right now: a failed
  withdrawal's is 0, because its hold was released) and, when opened, the ledger
  postings behind it. The *Ledger statement* tab lists every posting with a
  running balance, so the feed can always be checked against the ledger.
- **A deposit is pending until the webhook says otherwise.** Coming back from
  Checkout shows *pending* and a note that the money arrives with the verified
  webhook, not with the browser.
- **The demo checkout is the real webhook path minus Stripe's servers.** With
  `DEMO_MODE=true` and no `STRIPE_SECRET_KEY`, *Add funds* opens a wallet page
  in place of Stripe Checkout. Choosing an outcome builds the Checkout Session
  events Stripe would send, signs them with the webhook secret using Stripe's
  SDK, and posts them to `/webhooks/stripe`, where signature verification,
  `processed_events` dedupe and the deposit state machine run exactly as for
  Stripe. It is refused for deposits it did not open and for other users'
  deposits, and it is never on when a Stripe key is set. `DEMO_MODE` lets any
  signed-in user mint fictional money and flip the bank's switches, so it is
  for local demos only.
- **Live without websockets.** The wallet polls every 2 seconds while the tab
  is visible and highlights rows whose status changed.

Migration `006` adds indexes on `transfers (from_account_id)` and
`(to_account_id)` for the feed.

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
| **Where did every dollar go?** | `payouts across every outcome and paid deposits all match, and the totals tie out to the cent` |
| **Response cut off, retries exhausted, no webhook?** | `the bank's response is cut off, retries run out, no webhook ever comes: the statement settles it, exactly once` |
| Stripe charged, webhook lost? | `Stripe charged the card but the webhook was lost: the run credits the deposit once, and the late webhook changes nothing` |
| The statement itself is cut off? | `the provider's statement is itself cut off mid-way: the run fails, changes nothing, and the next one completes` (bank and Stripe) |
| Bank never got it: do we fail it on a guess? | `a pending payout the bank never received is in transit, not failed ...` |
| Bank contradicts a final state? | `the bank says failed after we settled it: an open break; accepting the bank refunds the user with a linked posting` |
| The user spent a wrong refund? | `we refunded a payout the bank actually paid: the user is debited if they can cover it, otherwise the platform absorbs it` |
| Bank lost a payout / has one we never sent? | `the bank lost a payout it acknowledged ...`, `a payout at the bank we never sent: only the platform can absorb it` |
| Same disagreement on every run? | `accept_ours moves no money; the same disagreement stays settled on later runs, and any change brings it back` |
| Double-clicked "Resolve"? | `10 simultaneous clicks on 'accept' post one correction ...` |
| A webhook fixes it while a person decides? | `if the money moved since the run looked, the correction is refused rather than applied twice` |
| Can the evidence be rewritten? | `runs, items and resolutions are evidence: they cannot be edited or deleted` |
| Double-clicked "Send" in the wallet? | `a double-click (two requests, one key) moves money once`, `25 concurrent clicks with one key post one transfer`, `a double-clicked withdrawal holds the money once` |
| Two users happen to send the same key? | `keys are per user: the same key from two users is two transfers` |
| Can a user act on someone else's account? | `always sends from the signed-in account ...`, `only the deposit's owner can see or complete it`, `rejects a missing, forged, tampered or expired token` |
| Does the wallet show the right state? | `stays pending until the (signed) webhook arrives, then settles once even if delivered twice`, `holds the money while pending, then settles, or fails and refunds` (with the statement's running balance) |
| Does the form reuse its key? | `reuses the key while the form says the same thing ...`, `makes a new key when the form changes ...` (`test/wallet-client.test.ts`) |

| Do co-host splits and fees add up to the cent? | `allocate always adds up exactly ...`, `partial refunds return the fee proportionally, never more than was charged, and all of it on the last one` |
| Same ticket payment webhook twice? | `the same payment webhook twice, or a second event for the same payment, credits it once` |
| Two buyers, one seat left? | `two buyers racing for the last seat: one gets it, the other is told it sold out` |
| Partial refund of a ticket? | `a partial refund of one ticket comes out of held proceeds, returns its share of the fee, and settles when Stripe confirms` |
| **Why is my payout $Y?** | `after the event, the schedule releases held money and pays each organizer once; the statement explains it to the cent` |
| Chargeback after payout? | `a chargeback after payout makes the organizer owe it, and their next payout is smaller by exactly that, with the reason` |
| **Cancel the event while the bank is down?** | `customers are refunded in full, the advance becomes the organizer's obligation, the payout goes out exactly once on recovery, and a recorded decision clears it` |
| Payment lands after the cancellation? | `a payment that lands after the event was cancelled is recorded, and refunded straight away` |
| Money on an organizer account that nothing explains? | `the database refuses money on an organizer's account that nothing explains`, `held proceeds can never go negative, even by a bug` |
| Ticket webhook lost? | `reconciliation against Stripe matches ticket orders, and settles one whose webhook never came` |

CI (GitHub Actions) runs the typecheck (API, dashboard, wallet and portal), builds the three apps, and runs the full suite against a Postgres 16 service container.

## Roadmap

1. ✅ **Internal transfers:** accounts, double-entry ledger, `POST /transfers`, idempotency, concurrency.
2. ✅ **Payments:** Stripe test Checkout, a verified webhook, and a deposit posted from the webhook (not from the success page).
3. ✅ **Reliability:** a transactional outbox, a concurrent-safe worker with retries and backoff, and idempotency-key scopes.
4. ✅ **Bank connector:** payouts to a mock bank with delayed success, failures, returns, lost responses, duplicate webhooks and outages, and a reconciler that recovers when the bank and we disagree.
5. ✅ **Reconciliation:** compare the ledger against the bank's and Stripe's records, prove the totals tie out, fix what the provider's record settles, and an admin dashboard where a person resolves the rest as auditable ledger postings.
6. ✅ **User dashboard:** a React wallet for balances and full history, adding funds (Stripe test Checkout, or a demo checkout), transfers and withdrawals, with client-side idempotency keys, and a one-command seeded demo with switches for the bank's failure modes.
7. ✅ **Product: payouts for small event organizers.** Events, tickets and orders on Stripe test Checkout, co-host splits, partial refunds, cancellations, chargebacks after payout, scheduled post-event payouts and early payouts through the mock bank, organizer obligations and recorded adjustments, reconciliation causes, and an organizer portal that explains every payout to the cent.
