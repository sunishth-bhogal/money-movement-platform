#!/usr/bin/env bash
# The organizer story, end to end, against a running stack:
#
#   sell tickets → the bank connector goes down → the organizer takes an
#   early payout (it waits) → the event is cancelled → every buyer is refunded
#   → the early payout is now money the organizer owes → the bank comes back
#   and pays the advance exactly once → reconciliation agrees with the bank →
#   a person records the repayment, with a cause → the audit trail.
#
# Start the stack first:
#
#   docker compose up --build
#   bash docs/demo/event-cancellation.sh
#
# It creates its own organizer and event, so it does not touch the seeded
# ones, and every run uses fresh idempotency keys: run it as often as you like.
# It needs DEMO_MODE=true (the compose default), curl and jq.
set -euo pipefail

API="${API_URL:-http://localhost:3000}"
BANK="${BANK_URL:-http://localhost:4000}"
ADMIN="${ADMIN_TOKEN:-local-admin-token}"
PAUSE="${PAUSE:-0}"           # seconds to pause between steps when presenting
RUN="$(date +%s)"             # makes this run's names and idempotency keys unique

bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; red=$'\e[31m'; cyan=$'\e[36m'; off=$'\e[0m'
if [[ ! -t 1 && -z "${FORCE_COLOR:-}" ]]; then bold=; dim=; green=; red=; cyan=; off=; fi

title() { printf '\n%s━━ %s %s\n' "$bold" "$1" "$off"; sleep "$PAUSE"; }
say()   { printf '%s\n' "$*"; }
why()   { printf '%s%s%s\n' "$dim" "$*" "$off"; }
step()  { printf '%s$ %s%s\n' "$cyan" "$*" "$off"; }
ok()    { printf '  %s✓ %s%s\n' "$green" "$*" "$off"; }
fail()  { printf '  %s✗ %s%s\n' "$red" "$*" "$off"; FAILED=1; }
check() { if [[ "$1" == "$2" ]]; then ok "$3 ($1)"; else fail "$3: expected $2, got $1"; fi; }
money() { awk -v c="$1" 'BEGIN { s = c < 0 ? "−" : ""; c = c < 0 ? -c : c; printf "%s$%.2f", s, c / 100 }'; }
FAILED=0

need() { command -v "$1" >/dev/null || { echo "This demo needs $1." >&2; exit 1; }; }
need curl; need jq

# post PATH TOKEN KEY BODY   (an empty TOKEN or KEY leaves that header out)
post()  { curl -s -X POST "$API$1" ${2:+-H "authorization: Bearer $2"} -H 'content-type: application/json' ${3:+-H "idempotency-key: $3"} -d "$4"; }
get()   { curl -sf "$API$1" ${2:+-H "authorization: Bearer $2"}; }
bank()  { curl -sf -X POST "$BANK/_admin/behaviour" -H 'content-type: application/json' -d "$1" >/dev/null; }

trap 'bank "{\"outage\":false}" 2>/dev/null || true' EXIT

curl -sf "$API/health" >/dev/null || { echo "The API is not answering at $API. Run: docker compose up --build" >&2; exit 1; }
curl -sf "$BANK/_admin/state" >/dev/null || { echo "The mock bank is not answering at $BANK." >&2; exit 1; }
[[ "$(get /box-office/config | jq -r .checkout)" == "demo_checkout" ]] ||
  { echo "Ticket sales need the demo checkout: DEMO_MODE=true and no STRIPE_SECRET_KEY." >&2; exit 1; }

# Wait until a jq expression over a GET is true, or give up after $3 seconds.
wait_for() {
  local path="$1" expr="$2" secs="$3" token="${4:-}"
  for _ in $(seq $((secs * 2))); do
    [[ "$(get "$path" "$token" | jq -r "$expr" 2>/dev/null)" == "true" ]] && return 0
    sleep 0.5
  done
  return 1
}

say "${bold}Ticket payouts: cancel an event while the bank is down, and account for every cent${off}"
say "${dim}API $API · mock bank $BANK · run $RUN${off}"

# ---------------------------------------------------------------------------
title "1. An organizer, an event, and two orders"
step "POST /organizers  {name: Night Market $RUN, bank account ••1111}     (operator)"
ORG="$(post /organizers "$ADMIN" "" "{\"name\":\"Night Market $RUN\",\"currency\":\"USD\",\"bank_account_number\":\"000123451111\"}" | jq -r .id)"
START="$(date -u -d '+10 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+10d +%Y-%m-%dT%H:%M:%SZ)"
END="$(date -u -d '+10 days 4 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+10d -v+4H +%Y-%m-%dT%H:%M:%SZ)"
step "POST /events  {General \$25.00, early payout of up to 50% allowed}"
EVENT_JSON="$(post /events "$ADMIN" "" "{\"name\":\"Night Market $RUN\",\"venue\":\"Old Town Square\",\"currency\":\"USD\",\"starts_at\":\"$START\",\"ends_at\":\"$END\",\"advance_bps\":5000,\"organizers\":[{\"organizer_id\":\"$ORG\",\"share_bps\":10000}],\"ticket_types\":[{\"name\":\"General\",\"price_cents\":2500,\"capacity\":100}]}")"
EVENT="$(jq -r .id <<<"$EVENT_JSON")"
TT="$(get /box-office/events | jq -r --arg e "$EVENT" '.data[] | select(.id == $e) | .ticket_types[0].id')"
TOKEN="$(post /organizer/session "" "" "{\"organizer_id\":\"$ORG\"}" | jq -r .token)"

buy() { # buy NAME QUANTITY OUTCOME → order id
  local id
  id="$(post "/box-office/events/$EVENT/orders" "" "demo-$RUN-$1" "{\"buyer_name\":\"$1\",\"buyer_email\":\"$(tr 'A-Z' 'a-z' <<<"$1")@example.com\",\"items\":[{\"ticket_type_id\":\"$TT\",\"quantity\":$2}]}" | jq -r .order.id)"
  post "/box-office/orders/$id/demo-checkout" "" "" "{\"outcome\":\"$3\"}" >/dev/null
  echo "$id"
}
step "POST /box-office/events/…/orders  Ana: 2 tickets, paid (Stripe sends the webhook twice)"
ANA="$(buy Ana 2 pay_duplicate_webhook)"
step "POST /box-office/events/…/orders  Ben: 1 ticket, paid"
BEN="$(buy Ben 1 pay)"
held="$(get /organizer/ "$TOKEN" | jq .balances.held_cents)"
say "  → \$75.00 sold. Fees: 5% + \$0.50 a ticket = \$5.25. Held for the organizer until after the event: $(money "$held")"
check "$held" 6975 "held once, despite the duplicate webhook"
why "Why held: ticket money is kept until the event has happened, because refunds are paid from it."

# ---------------------------------------------------------------------------
title "2. The bank connector goes down, and the organizer takes an early payout"
step "POST $BANK/_admin/behaviour  {outage: true}       every call to the bank now fails with 503"
bank '{"outage":true}'
step "POST /organizer/events/$EVENT/advance"
ADV="$(post "/organizer/events/$EVENT/advance" "$TOKEN" "" '{}')"
ADV_CENTS="$(jq .advance_cents <<<"$ADV")"; PAYOUT="$(jq -r .payout.id <<<"$ADV")"
say "  → advance of $(money "$ADV_CENTS") (half of what is held), payout $PAYOUT"
sleep 3
status="$(get /organizer/ "$TOKEN" | jq -r --arg p "$PAYOUT" '.payouts[] | select(.payout.id == $p) | .payout.status')"
check "$status" pending "the payout waits: the worker's calls to the bank fail, and it retries with backoff"
why "The money left the organizer's balance into 'payouts in flight' when the payout was"
why "created, in the same transaction as the outbox event that tells the worker to send it."

# ---------------------------------------------------------------------------
title "3. The event is cancelled, with the bank still down"
step "POST /organizer/events/$EVENT/cancel  {reason: Venue flooded}"
post "/organizer/events/$EVENT/cancel" "$TOKEN" "" '{"reason":"Venue flooded"}' | jq -r '"  → \(.refunds) refunds started"'
if wait_for "/box-office/orders/$ANA" '[.refunds[] | select(.status == "succeeded")] | length == 1' 20 &&
   wait_for "/box-office/orders/$BEN" '[.refunds[] | select(.status == "succeeded")] | length == 1' 20; then
  ok "Stripe confirmed both refunds: Ana gets \$50.00 back, Ben \$25.00. Buyers are never short."
else
  fail "the refunds did not succeed within 20s"
fi
B="$(get /organizer/ "$TOKEN")"
check "$(jq .balances.held_cents <<<"$B")" 0 "everything held went to the refunds"
check "$(jq .balances.owed_by_organizer_cents <<<"$B")" "$ADV_CENTS" "the advance is now owed by the organizer"
say "  → the organizer's available balance: $(money "$(jq .balances.available_cents <<<"$B")")"
why "Refunds are paid from held money first; whatever was already advanced comes out of the"
why "organizer's available balance, which may go negative. That is an obligation, recorded as"
why "ledger entries, not a number someone has to remember."
step "POST /organizer/events/$EVENT/cancel  (again)"
check "$(post "/organizer/events/$EVENT/cancel" "$TOKEN" "" '{"reason":"Venue flooded"}' | jq .refunds)" 0 "cancelling twice refunds nobody twice"

# ---------------------------------------------------------------------------
title "4. The bank comes back"
step "POST $BANK/_admin/behaviour  {outage: false}"
bank '{"outage":false}'
say "  waiting for the worker's next retry and the bank's settlement (up to 90s)..."
if wait_for /organizer/ "[.payouts[] | select(.payout.id == \"$PAYOUT\")][0].payout.status == \"succeeded\"" 90 "$TOKEN"; then
  ok "the advance was paid out"
else
  fail "the advance did not settle within 90s"
fi
at_bank="$(curl -sf "$BANK/_admin/state" | jq --arg p "$PAYOUT" '[.payouts[] | select(.reference == $p)] | length')"
check "$at_bank" 1 "the bank has exactly one payout for it, after all the retries"
why "Every retry carried the same idempotency key (payout:<id>), so the bank created it once."

step "POST /admin/reconciliation/runs  {source: mock_bank}"
RECON="$(curl -s -X POST "$API/admin/reconciliation/runs" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"source":"mock_bank","currency":"USD"}')"
check "$(jq -r '.totals.settled.balanced' <<<"$RECON")" true "our ledger and the bank's statement agree on what was paid out"

# ---------------------------------------------------------------------------
title "5. The organizer repays, and a person records it with a cause"
step "POST /admin/organizers/$ORG/adjustments  {cause: organizer_repaid, decided_by: ops}"
post "/admin/organizers/$ORG/adjustments" "$ADMIN" "demo-$RUN-repaid" \
  "{\"amount_cents\":$ADV_CENTS,\"cause\":\"organizer_repaid\",\"note\":\"Repaid by bank transfer, ref NM-$RUN\",\"decided_by\":\"ops@example.test\",\"event_id\":\"$EVENT\"}" >/dev/null
B="$(get /organizer/ "$TOKEN")"
check "$(jq .balances.available_cents <<<"$B")" 0 "nothing owed any more"
say "  The organizer's next statement, as the portal shows it:"
jq -r '.upcoming.summary[] | "    · " + .' <<<"$B"
why "Nothing here was a silent fix: the repayment is a ledger transfer against 'organizer"
why "adjustments', with a cause, a note and who decided it."

# ---------------------------------------------------------------------------
title "6. The audit trail for Ana's order"
step "GET /admin/orders/$ANA/trace"
curl -sf "$API/admin/orders/$ANA/trace" -H "authorization: Bearer $ADMIN" |
  jq -r '.transfers[] | [.created_at[11:19], (.kind // "stripe_settled"), .amount_cents, ((.memo // "Stripe confirmed the refund") + (.idempotency_key | if endswith(":held") then ", from held money" elif endswith(":available") then ", from the organizer'"'"'s balance (the advance)" else "" end))] | @tsv' |
  awk -F'\t' '{ printf "    %s  %-15s %8.2f  %s\n", $1, $2, $3 / 100, $4 }'
why "Each line is one ledger transfer, with its idempotency key (order:<id>:sale:<organizer>,"
why "refund:<id>:fee:<organizer>, ...), so a replay of any step finds it instead of repeating it."
step "GET /admin/events/invariants"
check "$(curl -sf "$API/admin/events/invariants" -H "authorization: Bearer $ADMIN" | jq .ok)" true "every order, refund, dispute and payout matches the ledger"

say ""
say "Portal: $API/portal/  (sign in as Night Market $RUN)"
if [[ $FAILED == 0 ]]; then say "${green}${bold}All checks passed.${off}"; else say "${red}${bold}Some checks failed.${off}"; exit 1; fi
