# Architecture

Four processes and one database. Everything that must be correct lives in
PostgreSQL; the processes are stateless and can be restarted or multiplied at
any time. The diagrams render on GitHub (Mermaid).

## The pieces

```mermaid
flowchart TB
    W["Wallet (React)"] & C["API clients"] -->|"Idempotency-Key"| M
    D["Admin dashboard (React)"] --> AD

    M["API: money routes<br/>transfers · deposits · payouts"]
    WH["API: webhooks<br/>Stripe · bank, signature checked"]
    AD["API: admin<br/>reconciliation · resolutions"]

    PG[("PostgreSQL 16, the source of truth<br/>append-only balanced ledger · deposit and payout state machines<br/>processed_events inbox · outbox · reconciliation evidence")]

    M ==>|"one transaction:<br/>ledger + state + outbox row"| PG
    WH ==>|"one transaction:<br/>processed_events + effects + outbox row"| PG
    AD ==>|"runs, proofs, decisions<br/>as new ledger transfers"| PG

    PG -->|"claim due rows<br/>SKIP LOCKED · lease · claim_token"| WK["Outbox worker (run any number)<br/>retries with backoff · dead-letters<br/>payout status checks · scheduled reconciliation"]

    WK -->|"payout.submit<br/>key payout:&lt;id&gt;"| BANK["Mock bank<br/>slow · fails · loses responses<br/>duplicate or no webhooks"]
    WK -->|"transfer.posted, deposit.*<br/>stable event_id"| DS["Downstream consumers"]
    M -->|"open Checkout<br/>key deposit-checkout:&lt;id&gt;"| STRIPE["Stripe (test mode)"]
    BANK -.->|"signed webhooks"| WH
    STRIPE -.->|"signed webhooks"| WH
```

Reconciliation (from the admin API or on the worker's schedule) also reads each
provider's whole statement: the bank's payouts and Stripe's Checkout Sessions.

What each process is allowed to do:

| Process | Writes money? | Talks to the outside? |
|---|---|---|
| API request handlers | Yes, one transaction per request: ledger rows, state change and outbox row together | Only to open a Stripe Checkout session, *before* any money moves |
| Webhook handlers | Yes, in the same transaction as the `processed_events` row | No |
| Outbox worker | Only through the same functions a webhook uses (`applyProviderState`) | Yes, but never inside a database transaction |
| Reconciliation run | Only forward fixes through the webhook's own functions; anything else waits for a person | Reads statements |

## The rules the database enforces

These are not conventions in application code; a bug cannot break them.

| Rule | How |
|---|---|
| Every transfer balances | Deferred constraint trigger: entries per transfer sum to zero at `COMMIT` |
| History is never rewritten | Triggers reject `UPDATE`, `DELETE`, `TRUNCATE` on `ledger_entries` and on the reconciliation evidence tables |
| A balance is the sum of its entries | `balance_cents` is written only by the ledger insert trigger |
| Users cannot overdraw | `CHECK (kind = 'system' OR balance_cents >= 0)` |
| One operation per idempotency key | `UNIQUE (idempotency_scope, idempotency_key)` on `transfers` |
| One effect per webhook | `PRIMARY KEY (provider, event_id)` on `processed_events` |
| Held money goes one way | `CHECK (settle_transfer_id IS NULL OR reverse_transfer_id IS NULL)` on `payouts` |
| A deposit is credited iff it succeeded | `CHECK ((status = 'succeeded') = (transfer_id IS NOT NULL))`, `transfer_id` unique |

## Where money sits

System accounts make every in-between state visible as a balance. Reconciliation
compares these control accounts, item by item, with each provider's records.

```mermaid
flowchart LR
    SC["Stripe clearing<br/>(goes negative by what<br/>Stripe collected)"] -- "deposit:&lt;id&gt;<br/>on verified webhook" --> U["User"]
    U -- "transfer" --> U2["Another user"]
    U -- "payout:&lt;id&gt;:hold" --> PIF["Payouts in flight"]
    PIF -- "payout:&lt;id&gt;:settle<br/>bank paid it" --> BP["Bank payouts"]
    PIF -- "payout:&lt;id&gt;:reverse<br/>bank failed it" --> U
    BP -- "payout:&lt;id&gt;:return<br/>bank sent it back" --> U
    RA["Reconciliation adjustments<br/>(platform's loss / gain)"] <-. "recon:&lt;resolution&gt;:&lt;n&gt;<br/>a person's decision" .-> U & PIF & BP
```

## A payout, end to end

The request never waits for the bank. The hold and the instruction to pay
commit together, and the bank's answer can arrive three ways, in any order,
any number of times.

```mermaid
sequenceDiagram
    autonumber
    participant U as Wallet
    participant A as API
    participant DB as Postgres
    participant W as Worker
    participant B as Bank
    participant R as Reconciliation

    U->>A: POST /me/payouts (Idempotency-Key)
    A->>DB: BEGIN · lock account · check funds<br/>insert payout · hold transfer · outbox payout.submit · COMMIT
    A-->>U: 201 pending (money on hold)

    W->>DB: claim event (SKIP LOCKED, lease, claim_token)
    W->>B: submit, key payout:<id>
    B--xW: response lost (the bank did create it)
    Note over W: timeout = unknown, not failed.<br/>Retry later with the same key.
    W->>B: submit again, same key
    B-->>W: 200, the same payout (replayed)
    W->>DB: applyProviderState(processing) → submitted

    B-)A: webhook payout.succeeded (maybe twice, maybe never)
    A->>DB: BEGIN · insert processed_events (dupe → skip)<br/>applyProviderState(succeeded) → settle transfer · COMMIT

    opt No webhook ever arrives
        W->>B: status lookup by key (payouts quiet for 1 min)
        B-->>W: succeeded
        W->>DB: applyProviderState(succeeded)
        R->>B: read the whole statement
        R->>DB: compare with control accounts · fix open items forward<br/>store the proof (ties out?)
    end
```

`applyProviderState` moves our payout *towards* the bank's state, so stale or
repeated news is a no-op, and a contradiction of a final state is recorded as a
discrepancy for a person, never fixed by code. The full matrix is in the
[README](../README.md#how-does-our-system-recover-when-the-providers-state-differs-from-ours).

## A deposit

```mermaid
sequenceDiagram
    autonumber
    participant U as Wallet
    participant A as API
    participant DB as Postgres
    participant S as Stripe

    U->>A: POST /me/deposits (Idempotency-Key)
    A->>DB: insert deposit 'created' · COMMIT
    A->>S: create Checkout session, key deposit-checkout:<id>
    A->>DB: save session · 'pending'
    A-->>U: checkout_url (no money moved)
    U->>S: pays, then closes the tab
    S-)A: checkout.session.completed (signed, maybe twice)
    A->>DB: BEGIN · processed_events · lock deposit · amount matches?<br/>credit from Stripe clearing · outbox deposit.succeeded · COMMIT
    Note over A,DB: The success page credits nothing.<br/>Only the verified webhook (or reconciliation<br/>reading Stripe's records) does.
```

## The outbox worker

```mermaid
stateDiagram-v2
    [*] --> pending: written in the same transaction as the change
    pending --> claimed: a worker claims it (lease + new claim_token)
    claimed --> published: publish OK and the claim_token is still ours
    claimed --> pending: publish failed (backoff with jitter), or the worker died and the lease ran out
    claimed --> dead: attempts used up, a permanent 4xx, or a crash on the final attempt
    dead --> pending: requeued by a person, or by the payout reconciler
    published --> [*]
```

(`claimed` is not a stored status: it is `pending` with `next_attempt_at` pushed
out by the lease, which is why a dead worker can never leave a row stuck.)

A worker that crashes simply lets its lease expire; another picks the row up.
A worker that stalls and wakes late cannot complete the row, because a new claim
issued a new `claim_token` (fencing). Delivery is at least once, so every event
carries a stable `event_id` for consumers to dedupe on.
