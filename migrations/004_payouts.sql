-- Stage 4 (bank connector): payouts to an external bank account.
--
-- A payout moves money OUT of the closed system, through a bank we only talk
-- to over the network. The ledger never waits for the bank: the user's money
-- is put on hold the moment the payout is accepted, and the hold is later
-- either settled (the bank paid it out) or reversed (the bank said it failed).
--
--   user ──hold──► Payouts in flight ──settle──► Bank payouts       (succeeded)
--                         └──────────reverse──► user                (failed)
--                  Bank payouts ──return──► user                    (returned after success)
--
-- Status, from OUR side:
--
--   rejected   insufficient funds when requested. Nothing was held or sent.
--   pending    held; the bank has not acknowledged it yet (maybe never got it,
--              maybe got it and the response was lost). We do not know.
--   submitted  the bank acknowledged it and is processing it.
--   succeeded  the bank says it paid out. The hold is settled.
--   failed     the bank says it did not pay out. The hold is reversed.
--   returned   it paid out, then the receiving bank sent it back. Re-credited.
--
-- We never decide on our own that a payout failed. Only the bank can say so
-- (a webhook, the response to our request, or a status lookup). Silence, a
-- timeout or an outage leave it pending, and pending is resolved by asking
-- the bank again with the same idempotency key.

CREATE TABLE payouts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key      TEXT        NOT NULL,
  request_hash         TEXT        NOT NULL,
  account_id           UUID        NOT NULL REFERENCES accounts(id),
  amount_cents         BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency             CHAR(3)     NOT NULL,
  bank_account_number  TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('rejected', 'pending', 'submitted', 'succeeded', 'failed', 'returned')),
  provider_payout_id   TEXT,
  failure_reason       TEXT,
  -- The ledger postings, one per step. Each is a system-scoped transfer with
  -- the key payout:<id>:<step>, so posting a step twice is a no-op.
  hold_transfer_id     UUID REFERENCES transfers(id),
  settle_transfer_id   UUID REFERENCES transfers(id),
  reverse_transfer_id  UUID REFERENCES transfers(id),
  return_transfer_id   UUID REFERENCES transfers(id),
  -- Set when the bank told us something that contradicts what we already
  -- recorded (e.g. "failed" for a payout it earlier said succeeded). No money
  -- moves automatically in that case; a person decides. Stage 5 lists these.
  discrepancy          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payouts_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT payouts_provider_id_unique UNIQUE (provider_payout_id),
  CONSTRAINT payouts_hold_unique UNIQUE (hold_transfer_id),
  -- The one rule that matters most: held money either leaves for the bank or
  -- comes back to the user, never both.
  CONSTRAINT payouts_settle_xor_reverse CHECK (settle_transfer_id IS NULL OR reverse_transfer_id IS NULL),
  CONSTRAINT payouts_succeeded_is_settled CHECK (status NOT IN ('succeeded', 'returned') OR settle_transfer_id IS NOT NULL),
  CONSTRAINT payouts_failed_is_reversed CHECK ((status = 'failed') = (reverse_transfer_id IS NOT NULL)),
  CONSTRAINT payouts_returned_is_recredited CHECK ((status = 'returned') = (return_transfer_id IS NOT NULL)),
  CONSTRAINT payouts_open_has_no_outcome CHECK (
    status NOT IN ('pending', 'submitted', 'rejected') OR (settle_transfer_id IS NULL AND reverse_transfer_id IS NULL))
);
CREATE INDEX payouts_account_idx ON payouts (account_id, created_at DESC);
-- The reconciler's query: open payouts that have gone quiet.
CREATE INDEX payouts_open_idx ON payouts (updated_at) WHERE status IN ('pending', 'submitted');
