# Demos

Two scripts, each played against the running stack (`docker compose up --build`)
and checking every outcome with ✓ or ✗. Both need `curl`, `jq` and
`DEMO_MODE=true` (the compose default), use fresh idempotency keys on every
run, put the mock bank's switches back when they exit, and exit non-zero if a
check fails. `API_URL`, `BANK_URL` and `ADMIN_TOKEN` override the defaults;
`PAUSE=2` adds pauses for presenting.

## The organizer story: cancel an event while the bank is down

```bash
bash docs/demo/event-cancellation.sh     # about 30 seconds, most of it waiting for the bank's retry
```

[`event-cancellation.sh`](event-cancellation.sh) creates its own organizer
and event (with early payouts allowed), so it leaves the seeded ones alone:

| Step | What it does | What it checks |
|---|---|---|
| **Sell** | Two orders through the box office and the demo checkout, one with Stripe's webhook delivered twice | The organizer's held balance went up once: $75.00 sold − $5.25 fees = $69.75 |
| **Bank down, early payout** | Turns on the mock bank's outage, then takes an early payout of 50% of what is held | The payout stays pending while the worker retries |
| **Cancel** | Cancels the event with the bank still down | Both buyers are refunded in full and Stripe confirms; held is 0; the early payout ($34.87) is now owed by the organizer; cancelling again refunds nobody |
| **Recover** | Turns the bank back on | The early payout succeeds, the bank holds exactly one payout for it, and a mock-bank reconciliation run ties out |
| **Decide** | Records the organizer's repayment as an adjustment (`cause: organizer_repaid`, a note, who decided) | Nothing owed; prints the next statement's summary |
| **Audit** | Prints the ledger trace of one order, and runs `/admin/events/invariants` | Every order, ticket, refund and dispute matches the ledger |

Then show the same organizer in the portal (<http://localhost:3000/portal/>,
*Organizer*), or a seeded one: Northside Sports Club's $32.00 payout explains a
chargeback that arrived after the event had been paid out.

## Failure scenarios: duplicated, raced and lost requests

![The three failure scenarios, played against the running stack](failure-scenarios.gif)

[`failure-scenarios.sh`](failure-scenarios.sh) plays three failure scenarios
against a running stack and checks each outcome, printing ✓ or ✗:

| Scenario | What it does | What it checks |
|---|---|---|
| **Duplicate transfer** | Sends the same `POST /me/transfers` twice in parallel, with one `Idempotency-Key` | Both responses name one transfer, one was replayed, one posting, the balance moved once |
| **Duplicate webhook** | Pays a deposit with the demo checkout's *deliver the webhook twice*; then makes the mock bank send every webhook three times and withdraws | One credit for the deposit; three deliveries of the same bank event, one `settle` transfer |
| **Lost provider response** | Makes the bank lose its next response and stop sending webhooks, then withdraws | The bank paid it and we still say pending; one reconciliation run settles it with one transfer, the bank holds one payout, the proof ties out, and a second run finds nothing to fix |

```bash
docker compose up --build                # starts everything and seeds Alice, Bob and Carol
bash docs/demo/failure-scenarios.sh      # about 10 seconds; PAUSE=2 adds pauses for presenting
```

It uses the wallet API, the admin API and the mock bank's switches on port 4000.

[`failure-scenarios.txt`](failure-scenarios.txt) is the plain-text output of
the recorded run.

### After the script: a break only a person can resolve

The script covers what code can fix by itself. To show what it can't, make
the bank contradict a payout we already settled, then run reconciliation from
the dashboard (<http://localhost:3000/dashboard/>, token `local-admin-token`):

```bash
# any succeeded payout's key, e.g. the $9.00 one from scenario 2
curl -s localhost:4000/_admin/state | jq -r '.payouts[] | select(.status == "succeeded") | .idempotency_key'
curl -s -X POST localhost:4000/_admin/tamper -H 'content-type: application/json' \
  -d '{"idempotency_key":"payout:<id>","status":"failed"}'
```

![The reconciliation dashboard with one open break](reconciliation-dashboard.png)

The run shows one open break ("The bank says failed, we recorded succeeded"),
still tying out because the break explains the difference. Click the payout
key for every transfer behind it, then resolve it with a cause and a note. The correction
is a new ledger transfer linked to your decision in the audit log, and the next
run is clean.
