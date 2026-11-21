#!/usr/bin/env bash
# Plays the three failure scenarios against a running stack and checks the
# outcome of each one, so you can show them live in an interview.
#
#   1. The same transfer sent twice at once         -> one transfer
#   2. The same webhook delivered more than once    -> one ledger posting
#   3. The bank's response is lost, and it sends no
#      webhook either                               -> reconciliation settles it
#
# Start the stack and seed it first:
#
#   docker compose up --build        # seeds Alice, Bob and Carol
#   bash docs/demo/failure-scenarios.sh
#
# It uses only the wallet API (/me), the admin API (/admin) and the mock
# bank's chaos switches, so it needs DEMO_MODE=true (the compose default).
# Every run uses fresh idempotency keys, so you can run it again and again.
# Needs curl and jq.
set -euo pipefail

API="${API_URL:-http://localhost:3000}"
BANK="${BANK_URL:-http://localhost:4000}"
ADMIN="${ADMIN_TOKEN:-local-admin-token}"
PAUSE="${PAUSE:-0}"           # seconds to pause between steps when presenting
RUN="$(date +%s)"             # makes this run's idempotency keys unique

bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; red=$'\e[31m'; cyan=$'\e[36m'; off=$'\e[0m'
if [[ ! -t 1 && -z "${FORCE_COLOR:-}" ]]; then bold=; dim=; green=; red=; cyan=; off=; fi

title() { printf '\n%s━━ %s %s\n' "$bold" "$1" "$off"; sleep "$PAUSE"; }
say()   { printf '%s\n' "$*"; }
why()   { printf '%s%s%s\n' "$dim" "$*" "$off"; }
step()  { printf '%s$ %s%s\n' "$cyan" "$*" "$off"; }
ok()    { printf '  %s✓ %s%s\n' "$green" "$*" "$off"; }
fail()  { printf '  %s✗ %s%s\n' "$red" "$*" "$off"; FAILED=1; }
check() { if [[ "$1" == "$2" ]]; then ok "$3 ($1)"; else fail "$3: expected $2, got $1"; fi; }
money() { awk -v c="$1" 'BEGIN { printf "$%.2f", c / 100 }'; }
FAILED=0

need() { command -v "$1" >/dev/null || { echo "This demo needs $1." >&2; exit 1; }; }
need curl; need jq

get()   { curl -sf "$API$1" -H "authorization: Bearer $2"; }
post()  { curl -s -X POST "$API$1" -H "authorization: Bearer $2" -H 'content-type: application/json' ${3:+-H "idempotency-key: $3"} -d "$4"; }
admin() { curl -sf "$API$1" -H "authorization: Bearer $ADMIN" "${@:2}"; }
bank()  { curl -sf -X POST "$BANK/_admin/behaviour" -H 'content-type: application/json' -d "$1" >/dev/null; }

# Put the bank back to normal however the script ends.
trap 'bank "{\"outage\":false,\"loseResponses\":0,\"webhookCopies\":1,\"webhooksEnabled\":true}" 2>/dev/null || true' EXIT

curl -sf "$API/health" >/dev/null || { echo "The API is not answering at $API. Run: docker compose up --build" >&2; exit 1; }
curl -sf "$BANK/_admin/state" >/dev/null || { echo "The mock bank is not answering at $BANK." >&2; exit 1; }

user_id() { curl -sf "$API/me/demo-users" | jq -r --arg n "$1" '[.data[] | select(.name == $n)][0].id // empty'; }
sign_in() { curl -sf -X POST "$API/me/session" -H 'content-type: application/json' -d "{\"account_id\":\"$1\"}" | jq -r .token; }
balance() { get /me "$1" | jq -r .available_cents; }

ALICE="$(user_id Alice)"; BOB="$(user_id Bob)"
[[ -n "$ALICE" && -n "$BOB" ]] || { echo "No Alice and Bob yet. Seed first: docker compose run --rm seed" >&2; exit 1; }
ALICE_T="$(sign_in "$ALICE")"; BOB_T="$(sign_in "$BOB")"

# Wait until a jq expression over a GET is true, or give up after $3 seconds.
wait_for() {
  local path="$1" expr="$2" secs="$3" token="${4:-$ALICE_T}"
  for _ in $(seq $((secs * 2))); do
    [[ "$(get "$path" "$token" | jq -r "$expr")" == "true" ]] && return 0
    sleep 0.5
  done
  return 1
}

say "${bold}Money movement platform: three ways money gets moved twice, or lost, and why it doesn't here${off}"
say "${dim}API $API · mock bank $BANK · run $RUN${off}"

# ---------------------------------------------------------------------------
title "1. The same transfer, sent twice at the same moment"
say "A double-click, or a phone retrying after a timeout: two identical requests"
say "arrive together. Both carry the same Idempotency-Key, because the client"
say "made one key for one intention."
before="$(balance "$ALICE_T")"
say "Alice has $(money "$before")."
KEY="demo-$RUN-transfer"
step "POST /me/transfers  Idempotency-Key: $KEY  {to: Bob, amount: \$12.34}   ×2, in parallel"
body="{\"to_account_id\":\"$BOB\",\"amount_cents\":1234}"
post /me/transfers "$ALICE_T" "$KEY" "$body" >"/tmp/demo-$RUN-a.json" &
post /me/transfers "$ALICE_T" "$KEY" "$body" >"/tmp/demo-$RUN-b.json" &
wait
for f in a b; do
  jq -r '"  → \(if .replayed then "replayed" else "created " end)  transfer \(.item.object_id)  \(.item.status_label)"' "/tmp/demo-$RUN-$f.json"
done
ids="$(jq -r .item.object_id "/tmp/demo-$RUN-a.json" "/tmp/demo-$RUN-b.json" | sort -u | wc -l | tr -d ' ')"
replays="$(jq -r .replayed "/tmp/demo-$RUN-a.json" "/tmp/demo-$RUN-b.json" | grep -c true || true)"
after="$(balance "$ALICE_T")"
TID="$(jq -r .item.object_id "/tmp/demo-$RUN-a.json")"
postings="$(get "/me/statement?limit=100" "$ALICE_T" | jq --arg t "$TID" '[.data[] | select(.transfer_id == $t)] | length')"
check "$ids" 1 "both responses name the same transfer"
check "$replays" 1 "one of them was answered from the first"
check "$postings" 1 "one posting on Alice's ledger statement"
check "$((before - after))" 1234 "Alice's balance went down once, by 1234 cents"
why "Why: the transfer row is the idempotency record, in the same transaction as the"
why "ledger entries. A unique index on (scope, key) makes the second request wait for"
why "the first, see the conflict, and return the stored transfer."
rm -f "/tmp/demo-$RUN-a.json" "/tmp/demo-$RUN-b.json"

# ---------------------------------------------------------------------------
title "2. The same webhook, delivered more than once"
say "Providers deliver at least once: any timeout on their side means a resend."
say "First Stripe (through the demo checkout, which signs real Stripe events and"
say "posts them to /webhooks/stripe), then the bank."
before="$(balance "$BOB_T")"
step "POST /me/deposits  {amount: \$25.00}                       as Bob"
DEP="$(post /me/deposits "$BOB_T" "demo-$RUN-deposit" '{"amount_cents":2500}' | jq -r .item.object_id)"
say "  → deposit $DEP: $(get "/me/deposits/$DEP" "$BOB_T" | jq -r .status_label)"
step "POST /me/deposits/$DEP/demo-checkout  {outcome: pay_duplicate_webhook}"
post "/me/deposits/$DEP/demo-checkout" "$BOB_T" "" '{"outcome":"pay_duplicate_webhook"}' |
  jq -r '.deliveries[] | "  → webhook delivery: HTTP \(.status) \(.outcome // .error.code // "")"'
after="$(balance "$BOB_T")"
credits="$(get "/me/statement?limit=100" "$BOB_T" | jq --arg d "deposit:$DEP" '[.data[] | select(.activity_id == $d)] | length')"
check "$credits" 1 "one credit on Bob's statement"
check "$((after - before))" 2500 "Bob's balance went up once, by 2500 cents"

say ""
say "Now the bank sends every webhook three times."
step "POST $BANK/_admin/behaviour  {webhookCopies: 3}"
bank '{"webhookCopies":3}'
step "POST /me/payouts  {amount: \$9.00, to account ••1111}       as Alice"
PO="$(post /me/payouts "$ALICE_T" "demo-$RUN-payout-dup" '{"amount_cents":900,"bank_account_number":"000123451111"}' | jq -r .item.object_id)"
say "  → payout $PO is pending, money on hold. Waiting for the bank to pay it out..."
if wait_for "/me/activity?limit=50" "[.data[] | select(.object_id == \"$PO\")][0].state == \"settled\"" 30; then
  ok "the payout settled"
else
  fail "the payout did not settle within 30s"
fi
sleep 1
# The newest payout.succeeded event in the bank's delivery log is this payout's.
event="$(curl -sf "$BANK/_admin/state" | jq -r '[.deliveries[] | select(.type == "payout.succeeded")] | last | .eventId')"
copies="$(curl -sf "$BANK/_admin/state" | jq --arg e "$event" '[.deliveries[] | select(.eventId == $e and .ok)] | length')"
settles="$(admin "/admin/reconciliation/trace?break_key=payout:$PO" | jq '[.transfers[] | select(.idempotency_key | endswith(":settle"))] | length')"
say "  → the bank delivered $event ${copies} times, and our endpoint answered 200 to each"
check "$copies" 3 "three deliveries of the same event"
check "$settles" 1 "one settle transfer in the ledger"
why "Why: processed_events has a primary key of (provider, event_id), and the insert"
why "is in the same transaction as the event's effects. The copies are acknowledged"
why "with 200 and skipped. If applying an event crashes, its record rolls back too,"
why "so the provider's next resend is processed rather than lost."
bank '{"webhookCopies":1}'

# ---------------------------------------------------------------------------
title "3. The bank's response is lost, and no webhook ever comes"
say "The worker sends the payout. The bank creates it, and the response never"
say "reaches us. Then the bank goes quiet: no webhook. Nobody tells us it was paid."
step "POST $BANK/_admin/behaviour  {loseResponses: 1, webhooksEnabled: false}"
bank '{"loseResponses":1,"webhooksEnabled":false}'
step "POST /me/payouts  {amount: \$7.00, to account ••1111}       as Alice"
PO="$(post /me/payouts "$ALICE_T" "demo-$RUN-payout-lost" '{"amount_cents":700,"bank_account_number":"000123451111"}' | jq -r .item.object_id)"
say "  → payout $PO, money on hold. Waiting for the bank to pay it out on its side..."
bank_status() { curl -sf "$BANK/_admin/state" | jq -r --arg k "payout:$PO" '[.payouts[] | select(.idempotency_key == $k)][0].status // "none"'; }
for _ in $(seq 60); do [[ "$(bank_status)" == "succeeded" ]] && break; sleep 0.5; done
ours="$(get "/me/activity?limit=50" "$ALICE_T" | jq -r --arg p "$PO" '[.data[] | select(.object_id == $p)][0] | "\(.state) (\(.status))"')"
say "  → the bank says: $(bank_status)"
say "  → we say:       $ours"
check "$(bank_status)" succeeded "the bank paid it out"
check "${ours%% *}" pending "our side still thinks it is pending: nobody told us"
step "POST /admin/reconciliation/runs  {source: mock_bank, currency: USD}"
RUNJSON="$(admin /admin/reconciliation/runs -X POST -H 'content-type: application/json' -d '{"source":"mock_bank","currency":"USD"}')"
RID="$(jq -r .id <<<"$RUNJSON")"
jq -r '"  → run \(.status): \(.provider_records) bank records, \(.matched) matched, \(.auto_resolved) auto-resolved, \(.open_breaks) open breaks"' <<<"$RUNJSON"
jq -r '.totals | to_entries[] | "  → \(.key) money: ledger \(.value.ledger_cents) − bank \(.value.provider_cents) = explained by open items \(.value.explained_cents), unattributed \(.value.unattributed_cents): \(if .value.balanced then "ties out" else "DOES NOT TIE OUT" end)"' <<<"$RUNJSON"
item="$(admin "/admin/reconciliation/runs/$RID" | jq -r --arg k "payout:$PO" '[.items[] | select(.break_key == $k)][0] | "\(.classification) → \(.outcome) (\(.auto_action // "no action"))"')"
say "  → this payout: $item"
ours="$(get "/me/activity?limit=50" "$ALICE_T" | jq -r --arg p "$PO" '[.data[] | select(.object_id == $p)][0].state')"
at_bank="$(curl -sf "$BANK/_admin/state" | jq --arg k "payout:$PO" '[.payouts[] | select(.idempotency_key == $k)] | length')"
settles="$(admin "/admin/reconciliation/trace?break_key=payout:$PO" | jq '[.transfers[] | select(.idempotency_key | endswith(":settle"))] | length')"
check "$ours" settled "the run settled our payout"
check "$settles" 1 "with one settle transfer"
check "$at_bank" 1 "and the bank holds one payout for it: it was never sent twice"
balanced="$(jq '[.totals[].balanced] | all' <<<"$RUNJSON")"
check "$balanced" true "the run's proof ties out to the cent"
step "POST /admin/reconciliation/runs  (again)"
again="$(admin /admin/reconciliation/runs -X POST -H 'content-type: application/json' -d '{"source":"mock_bank","currency":"USD"}' | jq -r .auto_resolved)"
check "$again" 0 "a second run finds nothing left to fix"
why "Why: the run compares books with books, the bank's statement against the money"
why "the ledger's control accounts attribute to each payout. Ours still open, the"
why "bank's final: it applies the bank's word through the same function a webhook"
why "uses, so it can only move money forward, once. Silence is never read as failure."

# ---------------------------------------------------------------------------
printf '\n'
if [[ "$FAILED" == 0 ]]; then
  say "${green}${bold}All three scenarios behaved: no money moved twice, none was lost.${off}"
else
  say "${red}${bold}Something did not behave. See the ✗ lines above.${off}"
fi
exit "$FAILED"
