# Interview talking points

How to talk about this project in a fintech engineering interview: the one-line
pitch, the hard question each stage answers, the trade-offs behind the design,
the bugs I found along the way, and what I would change at real scale.

Pictures to share: [the architecture](ARCHITECTURE.md), and
[the failure-scenario demo](demo/README.md) (a recording, plus a script you can
run live).

---

## The pitch (30 seconds)

> I built payouts for small event organizers: a sports club sells tickets
> through Stripe Checkout, the platform takes its fee, holds the proceeds until
> the event has happened, splits them between co-hosts, and pays each organizer
> through a bank connector. The interesting part is everything that goes wrong
> after the sale: partial refunds, an event cancelled after the organizer was
> paid early, a chargeback months later, a bank that is down. Money lives in an
> append-only double-entry ledger in Postgres that the database itself keeps
> balanced; every money-moving call is idempotent; and every payout has a
> statement that explains it to the cent, down to the ticket. When the
> organizer ends up owing money, the ledger shows it as a negative balance
> instead of hiding it, and settling it is a recorded decision with a cause,
> not a silent fix. There are about 180 tests, all against a real Postgres.

If they want one sentence: *"Every payout can explain itself to the cent, and
the database refuses any organizer ledger entry that doesn't say why it exists."*

Why this product: it uses everything the platform was built for (Stripe
Checkout, the ledger, idempotent transfers, the outbox, the bank connector,
reconciliation), and it has the questions marketplaces (Eventbrite, Stripe
Connect platforms, Shopify) actually lose money on: who pays for a refund after
the payout, and how do you tell a customer why their payout is smaller.

## The demo (3 minutes)

```bash
docker compose up --build                  # seeds two organizers and three wallet users
bash docs/demo/event-cancellation.sh       # PAUSE=2 to slow it down while talking
```

The story, each step checked by the script:

1. **Sell tickets.** Two orders, one with Stripe's webhook delivered twice: the
   organizer's held balance goes up once, by the price minus the fee.
2. **The bank connector goes down, and the organizer takes an early payout**
   (half of what is held). It waits: the worker's calls fail with 503 and it
   retries with backoff, same idempotency key.
3. **The event is cancelled.** Every buyer is refunded in full at once; buyers
   are never short. Held money covers what it can; what was paid early is now
   the organizer's **obligation**, a negative available balance. Cancelling
   again refunds nobody twice.
4. **The bank comes back.** The early payout goes out exactly once (the bank
   has one payout for it), and reconciliation agrees with the bank's statement.
5. **The organizer repays.** An operator records it as an adjustment with a
   cause (`organizer_repaid`), a note and who decided; the balance is back to
   zero, and the statement shows the line.
6. **The audit trail** of one order: sale, fee, the refund split between held
   money and the organizer's balance, the fee returned, Stripe's confirmation.

Then open the portal (<http://localhost:3000/portal/>, *Organizer* → Northside
Sports Club) and show the killer screen: the $32.00 payout. *"You sold $80.00;
fees $3.00; a chargeback on last month's fun run, $30.00 plus Stripe's $15.00
fee, after that event had already been paid out; so this payout is $32.00."*
Each line opens to the tickets behind it, each order to its ledger trace, and
*adds up to the cent* is computed, not asserted.

The original platform demo still works and is worth 1 minute if they ask about
idempotency directly: `bash docs/demo/failure-scenarios.sh` (duplicate
transfer, duplicate webhook, lost bank response; see [`demo/README.md`](demo/README.md)).

---

## Stage by stage: the hard question, and my answer

Each stage was built around one question an interviewer at a payments company
would ask. Lead with the question, then the answer, then the test that proves it.

### 1. Ledger and transfers: *"Can two simultaneous transfers overspend an account?"*

**Answer.** No. In one transaction I lock both account rows with
`SELECT ... FOR NO KEY UPDATE`, in id order, check the balance while holding the
lock, then insert the transfer and both ledger entries. A second transfer from
the same account queues on the lock and reads the new balance.

- **Why id order?** A→B and B→A at once would deadlock if each locked its own
  source first. A global order makes that impossible.
- **Why `FOR NO KEY UPDATE`, not `FOR UPDATE`?** It's the weakest lock that
  still serialises balance changes, and it doesn't block the `KEY SHARE` locks
  foreign-key checks take, so unrelated inserts referencing the account aren't
  held up.
- **Defence in depth.** `CHECK (balance_cents >= 0)` for users. A test runs a
  deliberately naive lock-free version: both debits pass the app check, and
  Postgres rejects one.

**Proof:** "20 simultaneous $10 transfers from a $50 account: exactly 5
succeed." Removing the lock line fails it and both deadlock tests.

**Follow-up you'll get: "Why is the balance stored at all, if the ledger is the
truth?"** One row gives a lock target and an O(1) read. It's a cache maintained
only by a trigger on `ledger_entries`, in the same transaction, and a test
helper recomputes every balance from the ledger after every test.

### 1b. Idempotency: *"What if the database commits but the response is lost?"*

**Answer.** The client retries with the same `Idempotency-Key` and gets the
original response back, with `Idempotent-Replayed: true`. Money moves once.

- The transfer row **is** the idempotency record, written in the same
  transaction as the ledger entries, so "money moved but key not saved" can't
  happen, and there's no `in_progress` state to get stuck in.
- Concurrent duplicates: `UNIQUE (scope, key)` + `INSERT ... ON CONFLICT DO
  NOTHING`. The second insert waits for the first transaction, then sees the
  conflict and returns the stored row.
- Same key, different body → `422`. I fingerprint the canonical body.
- Rejections are replayed too (like Stripe): same key, same answer, even if the
  account has since been funded.
- Two places the response can be lost, both tested over real HTTP: after
  COMMIT on the way to the client, and **during** COMMIT, where the server
  itself doesn't know. There it answers `500`, which means "unknown, retry with
  the same key", never "didn't happen".

### 2. Deposits: *"The user paid and closed the tab. Do they get their money? Once?"*

**Answer.** The success page credits nothing: anyone can type that URL, and
many users never land on it. Only a signed Stripe webhook credits the ledger.

- Verify the signature against the **raw** body (re-serialised JSON has
  different bytes), with Stripe's 5-minute tolerance against replays.
- One transaction: record the event in `processed_events`, lock the deposit,
  advance its state machine, post the credit, write the outbox row.
- Three layers stop a double credit: the event id primary key (same event
  twice), the deposit row lock plus a final-state check (two *different*
  events for one payment, e.g. `completed` then `async_payment_succeeded`), and
  schema backstops (`transfer_id` unique, `status = 'succeeded'` iff credited).
- Opening Checkout can't be inside a DB transaction, so it's two steps: commit a
  `created` row, then call Stripe with its own idempotency key derived from the
  deposit id. A retry repeats only the Stripe call and gets the same session.
- Paid amount ≠ requested → `requires_review`, not credited. I refuse to guess.

### 3. Outbox: *"How do other systems hear about a transfer, exactly once?"*

**Answer.** They hear at least once, and dedupe on a stable `event_id`.
Exactly-once delivery across two systems doesn't exist; exactly-once *effect*
does.

- "Commit then publish" loses events on a crash between the two; "publish
  then commit" announces things that never happened. So the event is a row
  written **in the same transaction** as the change. It exists iff the change
  committed.
- The worker claims rows with `FOR UPDATE SKIP LOCKED`, stores the claim as a
  lease (`next_attempt_at` pushed forward) plus a `claim_token`, commits, then
  publishes **outside** any transaction.
- **Fencing:** completing requires the same `claim_token`, so a worker that
  stalled past its lease can't overwrite the one that took over.
- Exponential backoff with equal jitter; dead after N attempts or a permanent
  4xx; a crash counts as an attempt, so a poison message can't loop forever.

**Proof:** 6 workers drain 300 events, each delivered once; removing `SKIP
LOCKED` fails it with duplicates.

### 4. Payouts: *"The bank timed out. Did it pay or not?"*

**Answer.** We don't know, so we don't guess. A timeout, a connection error, a
`5xx` or `429` is **unknown**: change nothing, retry with the **same** key
(`payout:<id>`), and the bank returns the payout it already made. Only a `422`
(definite refusal) or the bank saying "failed" fails a payout.

- `POST /payouts` makes **no** network call. One transaction holds the money
  (user → `Payouts in flight`) and writes `payout.submit` to the outbox. Hold
  and instruction commit together.
- The bank's word arrives three ways (our response, a webhook, a status
  lookup), in any order, any number of times. All three go through one
  function, `applyProviderState`, that moves our payout *towards* the bank's
  state. Stale news is a no-op; a contradiction of a final state is recorded
  as a discrepancy and **no money moves**.
- **Never infer failure from silence.** If the bank has no record, the request
  may still be in flight; refunding then would pay the user twice. Instead the
  reconciler re-queues a dead submit (same key, so it's safe).

**Proof:** a chaos test sends 30 payouts through lost responses, an outage,
duplicate webhooks and no webhooks; each ends in the bank's state and the bank
holds 30 payouts, none twice. Mutation check: a fresh key per attempt fails 7
tests.

### 5. Reconciliation: *"How do you prove where every dollar went?"*

**Answer.** Stop trusting messages and compare books with books: the
provider's statement against what the ledger's control accounts attribute to
each payout or deposit. Every run stores a proof:

```
ledger total − provider total = Σ (ledger − provider) over the remaining items,  and  unattributed = 0
```

So every cent of difference has a named item, and nothing on a control account
belongs to nobody.

- Compare **money**, not status labels. "Returned" vs "failed" with the money
  back with the user isn't a break; "succeeded" vs "failed" with $20 sitting in
  `Bank payouts` is.
- A run fixes only what is still **open** on our side and **final** at the
  provider, through the webhook's own function, so it can only move money
  forward, once.
- A partial statement (a page failed) fails the whole run and changes
  nothing; otherwise every payout on the missing page looks "missing at the bank".
- Anything that contradicts a final state goes to a person. Their decision is
  an append-only row, and any correction is a **new** balanced transfer linked
  to it, never an edit. Resolving re-checks the ledger under lock and refuses
  with `ledger_changed` if a webhook moved the money meanwhile.

### 6. Wallet: *"The user double-clicks Send. What happens?"*

**Answer.** The browser makes one idempotency key per *intention* and keeps it
while the form's fields are unchanged, so a double-click, a second press after
a slow answer, or a retry after "no answer" all reuse it. The server scopes
wallet keys per user (`wallet:<account>:<key>`), so two users can't collide or
block each other. When the outcome is unknown, the UI says so and says pressing
again is safe.

### 7. Organizer payouts: *"Why is my payout $Y?"*

**Answer.** Because the statement is built from the ledger, not from the order
tables. Every transfer that touches an organizer's accounts writes a posting
row (sale, fee, refund, fee returned, chargeback, release, advance, payout,
adjustment, with the event, order or refund behind it) in the same
transaction, and a deferred constraint trigger refuses to commit an organizer
ledger entry that has no such row. So the statement can't leave anything out:
each payout's window runs from the previous payout to this one, lines are
grouped by event and kind, and `opening + Σ lines = payout` is checked and
shown. If that check ever failed, the page would say so.

- **Held vs available.** Proceeds are *held* until `hold_hours` after the event
  (refunds come out of it first; the database refuses a negative held balance),
  then *released* to *available* and paid out whole.
- **Co-hosts.** Each sale is split by share with a largest-remainder allocation
  in integer cents, so the parts always add up to the order exactly.
- **Partial refunds.** Split across organizers in proportion to what each still
  has from that order; the platform returns the same fraction of its fee, and
  all of what's left of it on the final refund, so rounding never strands a cent.

### 8. Cancellation and chargebacks: *"The event was cancelled after you paid the organizer. Who pays the buyers?"*

**Answer.** The buyers are refunded in full, immediately; that's never in
question. The organizer's held money covers what it can, and whatever was
already paid out (an early payout, or a chargeback after the post-event
payout) comes out of their *available* balance, which is allowed to go
negative. That negative balance is the obligation: a fact in the ledger, not a
number in someone's spreadsheet. It comes out of their next payout first, with
the reason on the statement; or a person records how it was settled
(`organizer_repaid`, `debt_written_off`, ...), as a transfer with a cause, a
note and their name.

- **During a bank outage** the early payout's money is already in *payouts in
  flight* (held when it was created, with its outbox row, in one transaction),
  so cancelling can't refund it a second time; when the bank comes back, the
  retry uses the same key and the bank pays once.
- **Chargebacks** take the amount plus Stripe's $15 fee; a dispute won brings
  the amount back but not the fee, as at Stripe. If a dispute is bigger than
  what's left of the order, the platform absorbs the excess rather than
  charging an organizer for something they never received.
- **A refund Stripe fails** goes to `requires_review`; no money is moved back
  on a guess.

**Proof:** `cancel the event while the bank connector is down: customers are
refunded in full, the advance becomes the organizer's obligation, the payout
goes out exactly once on recovery, and a recorded decision clears it`.

---

## Design trade-offs to be ready for

| Choice | Alternative | Why I chose it, and when I'd switch |
|---|---|---|
| Explicit row locks under `READ COMMITTED` | `SERIALIZABLE` | Both are correct. Serializable resolves conflicts by **aborting**, which pushes retries into every caller and degrades badly on a hot account (a merchant receiving thousands of payments). Row locks make contention **queue** instead, and the locking is visible in code. I still retry on `40001`/`40P01` as a safety net, which is safe only because the transaction has no external side effects. I'd consider serializable for complex multi-row invariants that are hard to express as "lock these rows". |
| Cached balance on the account row | Sum the ledger on every read | One lock target and an O(1) read. Kept honest by a trigger in the same transaction and recomputed in tests. At scale, a hot account's single row becomes the bottleneck; see "at real scale". |
| Transfer row = idempotency record | Separate idempotency table with `in_progress` | Same transaction, so no stuck `in_progress` and no "key saved, money didn't move". Works because the operation touches only Postgres; for an external call first (Checkout) I use an explicit recorded state machine instead. |
| Transactional outbox | Publish after commit; CDC (Debezium) | Outbox gives atomicity with plain SQL. CDC on the WAL would remove the polling and the table writes; I'd move to it at volume, keeping the same at-least-once contract. |
| Lease in `next_attempt_at` + claim token | `status = 'in_progress'` + heartbeat | A lease can't get stuck when a worker dies; the token fences zombies. Heartbeats add moving parts for no gain at this publish latency. |
| Polling | `LISTEN/NOTIFY` | Polling is needed anyway as the fallback, so it comes first. NOTIFY would cut latency. |
| Converge to provider state (one function) | Handle each message type separately | Order and repetition stop mattering. It's a state machine that only moves forward, with contradictions escalated to a person. |
| Hold money at request time | Debit only on bank success | The user can't spend money that's on its way out, and the hold + instruction commit atomically. |
| Reconciliation on money positions | On status labels | Labels can disagree harmlessly; money in the wrong place can't. |
| Humans resolve contradictions of final states | Auto-reverse | Code can't safely claw back money the user may have spent. Every decision is audited and posts a new transfer. |
| Organizer's available balance may go negative | Block refunds once paid out; or the platform eats every loss | Buyers must be refunded regardless, and the debt is real; hiding it in a platform loss account loses the information that this organizer owes it. Held money can't go negative, so the obligation appears only once the money has really left. |
| Hold proceeds until after the event | Pay out on every sale | Refunds and cancellations are paid from held money, so the common case never creates a debt. Early payouts are an explicit, capped, recorded choice. |
| Return the platform fee on refunds | Keep it | A cancelled event shouldn't cost the organizer the fee on tickets they didn't sell. A product decision, and easy to change: the fee return is its own transfer. |
| Statement from the ledger + posting reasons | Statement from orders and refunds tables | The ledger is what was paid. A trigger makes "a ledger entry with no reason" impossible, so the explanation is complete by construction. |
| Tests against real Postgres | Mocks | Locks, deadlocks, `SKIP LOCKED` and unique-index races only exist in a real database. |

## Bugs I found, and traps I designed around

Two of these were real bugs in code that had already shipped (stage 2), found
by attacking my own design in stage 3. The rest are traps that the obvious
implementation falls into; each has a test that would fail if the obvious code
came back. Be clear about which is which if asked.

**Bugs found and fixed:**

1. **A client could block a deposit forever (idempotency key squatting).** The
   webhook posts its credit under the key `deposit:<id>`, and the deposit id is
   in the client's own response. A client could send `deposit:<id>` as its own
   key first (even a rejected transfer stores its key). The webhook then hit
   "key reused with a different body", returned `500` on every Stripe retry,
   and the deposit could never be credited. **Fix:** keys have a scope,
   `UNIQUE (idempotency_scope, idempotency_key)`, `api` vs `system`, with a
   migration moving existing deposit transfers to `system`.
2. **The public API could mint money.** System accounts may go negative (that's
   how money enters the books), so `POST /transfers` *from* the Stripe clearing
   account created money from nothing. **Fix:** API-scoped transfers must be
   between two user accounts (`403 system_account_not_allowed`).
**Traps the obvious implementation falls into:**

- **Refunding a cancelled event's early payout twice.** The obvious cancel
  refunds from "what the organizer was owed", which still counts the early
  payout the bank hasn't sent. Here it was already moved to *payouts in flight*
  when the payout was created, so it's gone from the organizer's balances, and
  the refund takes it from *available*, which goes negative, instead.
- **A statement that adds up "most of the time".** Computing it from orders and
  refunds misses chargeback fees, failed payouts and adjustments. Built from
  ledger entries with a reason each, and checked, it can't.

3. **The lost COMMIT acknowledgement.** The obvious handler treats any DB error
   as "failed". If COMMIT succeeds but the ack is lost, the server doesn't know.
   Saying "failed" invites the client to try a *new* key and pay twice. **Fix:**
   answer `500` ("unknown, retry with the same key"); a test commits for real,
   then simulates the dropped connection.
4. **A poison message can loop forever.** If an event crashes the worker and
   failures are only counted when the worker records them, the lease expires
   and the event is retried indefinitely. **Fix:** the claim increments `attempts`, so a crash
   counts, and a crash on the final attempt retires the event as `dead`.
5. **"No record at the bank" looks like "failed".** The obvious reconciler
   refunds a pending payout the bank doesn't know about. But the request may be
   in flight, and the bank may still pay it: that's paying twice. **Fix:**
   never infer failure from silence; re-queue the submit (same key) instead,
   and only treat it as a discrepancy if the bank had *acknowledged* it.
6. **A partial statement produces false breaks.** If one page of the bank's
   statement fails, every payout on it looks "missing at provider", and an
   eager fix would move money. **Fix:** any failed page fails the
   whole run, which changes nothing.
7. **A resolution racing a webhook can correct twice.** An operator decides
   based on a run; meanwhile the webhook arrives and fixes it. **Fix:** a
   resolution takes the same locks as webhooks, re-reads the ledger, and
   refuses with `ledger_changed` if money moved since the run looked.

How I make sure the tests are real: **mutation checks.** For each key test I
remove the line that makes it pass (the row lock, `SKIP LOCKED`, the claim-token
check, the stable payout key, signature verification) and confirm the test fails.

## What I'd do at real scale

Say this as "here's where this design breaks, and what I'd do", not as a
list of buzzwords.

- **Hot accounts.** A merchant receiving thousands of payments a second
  serialises on one row lock. Options: split the account into N sub-account
  shards and sum them for reads; or for credits only (which can't overdraw),
  skip the lock and append entries, computing the balance asynchronously.
  Debits still need a lock or a reservation.
- **Ledger size.** Partition `ledger_entries` by time; keep periodic balance
  snapshots so a balance is "snapshot + entries since". Archive old partitions.
- **Sharding.** Shard by account id. Transfers between shards become a
  two-phase saga through a clearing account (debit on shard A to "in transit",
  credit on shard B), each step idempotent, reconciled like a payout.
- **Outbox at volume.** CDC from the WAL (Debezium → Kafka) instead of polling,
  per-aggregate ordering via partition key, and pruning of published rows.
- **Idempotency keys** scoped per API client and expired after a window (Stripe
  keeps them 24h), in their own table once transfers are archived.
- **Reconciliation** per statement period (a day) with a margin for records
  that straddle the boundary, statements streamed into a staging table, and
  alerting on breaks and on dead events.
- **Auth and controls.** Real API auth with per-client keys; operator SSO and
  roles; a second approver ("four eyes") for corrections above a threshold;
  limits and velocity checks before money moves.
- **Money.** Multi-currency with FX as explicit transfers through FX accounts,
  never implicit conversion; amounts in minor units per currency (JPY has 0
  decimals, some have 3).
- **Compliance.** KYC before payouts, sanctions screening, and audit retention.
  Refunds, disputes and chargebacks as reversing transfers.
- **Operations.** Metrics on outbox lag, dead events, payouts held over an
  hour, and open breaks; runbooks for each; chaos tests in staging like the
  ones the mock bank does here.

## Questions they might ask, short answers

- **"Why not just use a database transaction for the bank call?"** You can't
  roll back someone else's server, and holding a transaction across a slow
  network call holds locks and a pooled connection for as long as the bank
  takes.
- **"Is your system exactly-once?"** Effects are exactly-once; delivery is at
  least once. Every boundary has a stable id the receiver dedupes on, in the
  same transaction as the effect.
- **"How do you know the ledger is right?"** The database rejects unbalanced
  transfers and edits; tests recompute every balance from entries after every
  test; and reconciliation proves our control accounts against the providers'
  own records.
- **"What happens if the worker is down for an hour?"** Nothing is lost: events
  wait in the outbox, payouts stay held. When it's back, it drains with
  backoff. Payouts held over an hour show on the dashboard.
- **"What's the worst bug you could still have?"** Something the provider does
  that my mock bank doesn't model, like partial payouts or a changed amount
  after settlement. Reconciliation is the safety net for exactly that: it
  would show up as a break with money attributed to it.
- **"Why is the organizer's balance allowed to be negative?"** Because after a
  payout, a refund or chargeback can only be paid by the platform, and the
  organizer genuinely owes it. Hiding it would mean writing it off silently.
  The held balance can't go negative; the database enforces it.
- **"How do you split $10.00 three ways?"** Integer cents, largest remainder:
  $3.34, $3.33, $3.33, deterministic, always summing to the total.
- **"Reconciliation found a contradiction. Do you fix it?"** Code fixes only
  what the provider's final record settles, through the same function the
  webhook uses. Everything else is a break for a person, who records a cause
  (`missed_notification`, `provider_error`, `our_error`, ...) and a decision;
  any correction is a new transfer linked to it.
- **"What would you build next?"** Real auth on the raw API, then a bank-data
  connector (Plaid Sandbox) that syncs transactions and handles them moving
  from pending to posted, which is the same "converge to the provider's state"
  problem from the other direction.
