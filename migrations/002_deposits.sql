-- Stage 1 (payments): deposits funded through Stripe Checkout (test mode).
--
-- A deposit is a small state machine. The browser never moves it forward;
-- only a verified Stripe webhook does:
--
--   created ──(Checkout session created)──► pending ──(paid)──────────────► succeeded
--                                             │  └─(async method)► processing ─┬─► succeeded
--                                             │                                └─► failed
--                                             └─(session expired)──────────────► expired
--
-- 'requires_review' is for a paid session whose amount or currency does not
-- match what we asked for. Money was collected, but we refuse to guess what to
-- credit, so a person has to look at it.

-- System accounts get a stable code so code can find e.g. the Stripe clearing
-- account for a currency without hard-coding ids.
ALTER TABLE accounts ADD COLUMN system_code TEXT;
ALTER TABLE accounts ADD CONSTRAINT accounts_system_code_only_for_system
  CHECK (system_code IS NULL OR kind = 'system');
CREATE UNIQUE INDEX accounts_system_code_currency_unique
  ON accounts (system_code, currency) WHERE system_code IS NOT NULL;

CREATE TABLE deposits (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-supplied, like POST /transfers, so a retried "add funds" click
  -- returns the same Checkout session instead of opening a second one.
  idempotency_key             TEXT        NOT NULL,
  request_hash                TEXT        NOT NULL,
  account_id                  UUID        NOT NULL REFERENCES accounts(id),
  amount_cents                BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency                    CHAR(3)     NOT NULL,
  status                      TEXT        NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'processing', 'succeeded', 'failed', 'expired', 'requires_review')),
  stripe_checkout_session_id  TEXT,
  stripe_payment_intent_id    TEXT,
  checkout_url                TEXT,
  -- Set exactly when the deposit has been credited to the ledger.
  transfer_id                 UUID REFERENCES transfers(id),
  failure_reason              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deposits_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT deposits_session_unique UNIQUE (stripe_checkout_session_id),
  CONSTRAINT deposits_transfer_unique UNIQUE (transfer_id),
  -- "Succeeded" and "has a ledger posting" are the same fact, enforced here.
  CONSTRAINT deposits_succeeded_iff_posted CHECK ((status = 'succeeded') = (transfer_id IS NOT NULL))
);
CREATE INDEX deposits_account_idx ON deposits (account_id, created_at DESC);
