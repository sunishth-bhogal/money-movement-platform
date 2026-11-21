-- Stage 2: accounts, transfers, immutable double-entry ledger, processed events.
-- All money is stored as integer minor units (cents) in BIGINT. Never floats.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- accounts
-- balance_cents is a *cache* of SUM(ledger_entries.amount_cents). It is only
-- ever changed by the trigger on ledger_entries below, never by application
-- code, so it cannot drift from the ledger. It exists so that a transfer can
-- lock one row (SELECT ... FOR UPDATE) and read the balance in O(1).
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  currency       CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- 'user' accounts can never go negative. 'system' accounts (e.g. the funding
  -- source that will later mirror Stripe) are allowed to.
  kind           TEXT        NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  balance_cents  BIGINT      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last line of defence: even if application code had a race, the database
  -- refuses to commit a negative user balance.
  CONSTRAINT user_balance_non_negative CHECK (kind = 'system' OR balance_cents >= 0)
);

-- ---------------------------------------------------------------------------
-- transfers
-- One row per client request (per idempotency key). Rejected attempts are kept
-- too, so a retry of a rejected request gets the same answer back.
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT        NOT NULL,
  request_hash     TEXT        NOT NULL,           -- sha256 of the canonical request body
  from_account_id  UUID        NOT NULL REFERENCES accounts(id),
  to_account_id    UUID        NOT NULL REFERENCES accounts(id),
  amount_cents     BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency         CHAR(3)     NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN ('pending', 'posted', 'rejected')),
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfers_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT transfers_rejected_has_reason CHECK ((status = 'rejected') = (failure_reason IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- ledger_entries: append-only, double-entry.
-- Signed amounts: negative = debit (money leaves the account),
-- positive = credit (money arrives). Every transfer's entries sum to zero.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  transfer_id   UUID        NOT NULL REFERENCES transfers(id),
  account_id    UUID        NOT NULL REFERENCES accounts(id),
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents <> 0),
  currency      CHAR(3)     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx  ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Immutability: corrections are new, reversing entries, never edits.
CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();

-- Entry currency must match the account currency, and the balance cache is
-- maintained here, in the same transaction as the entry insert.
CREATE FUNCTION ledger_entries_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct_currency CHAR(3);
BEGIN
  UPDATE accounts
     SET balance_cents = balance_cents + NEW.amount_cents
   WHERE id = NEW.account_id
  RETURNING currency INTO acct_currency;

  IF acct_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'currency mismatch: entry % vs account %', NEW.currency, acct_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_entries_apply_balance
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_apply();

-- Double-entry invariant, checked at COMMIT (deferred) so that both legs can
-- be inserted one after the other inside the same transaction.
CREATE FUNCTION ledger_entries_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO total
    FROM ledger_entries WHERE transfer_id = NEW.transfer_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'unbalanced transfer %: entries sum to %', NEW.transfer_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_balanced();

-- ---------------------------------------------------------------------------
-- processed_events: inbox for external events (Stripe / bank webhooks in later
-- stages). The primary key makes "process this event at most once" a
-- database guarantee rather than an application convention.
-- ---------------------------------------------------------------------------
CREATE TABLE processed_events (
  provider      TEXT        NOT NULL,
  event_id      TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
