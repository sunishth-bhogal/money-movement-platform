-- Stage 5 (reconciliation): compare our ledger with the providers' own records.
--
-- A run reads a provider's statement (the mock bank's payouts, Stripe's
-- Checkout Sessions) for one currency, compares it item by item with the
-- money our ledger says is at that provider, and stores what it found. Runs
-- and their items are evidence: they are written once and never changed.
--
-- A person resolves what the run could not, from the admin dashboard. A
-- resolution is also written once, and any money it moves is a new ledger
-- transfer linked to it. Nothing in the ledger is ever edited.
--
--   reconciliation_runs ──< reconciliation_items ──< reconciliation_resolutions ──< reconciliation_resolution_postings >── transfers

CREATE TABLE reconciliation_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT        NOT NULL CHECK (source IN ('mock_bank', 'stripe')),
  currency          CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status            TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  -- Counts, filled in when the run completes.
  provider_records  INT,
  ledger_records    INT,
  matched           INT,
  in_transit        INT,
  auto_resolved     INT,
  open_breaks       INT,
  acknowledged      INT,
  -- The proof, per dimension (held / settled): ledger total, provider total,
  -- the part explained item by item, and anything left unexplained.
  totals            JSONB,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT reconciliation_runs_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT reconciliation_runs_failed_has_error CHECK ((status = 'failed') = (error IS NOT NULL))
);
CREATE INDEX reconciliation_runs_latest_idx ON reconciliation_runs (source, currency, started_at DESC);

-- A run may be updated exactly once, from running to its final state. After
-- that it is evidence, and evidence is not edited.
CREATE FUNCTION reconciliation_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' THEN
    RAISE EXCEPTION 'reconciliation run % is final (% not allowed)', OLD.id, TG_OP USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.source <> OLD.source OR NEW.currency <> OLD.currency OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'reconciliation run identity cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_runs_guard BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_guard();

-- Generic append-only guard, the same rule as ledger_entries.
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- reconciliation_items: one row per thing a run could not simply match.
--
-- break_key names the thing across runs: payout:<our id>, deposit:<our id>,
-- or, for a provider record we have nothing for, bank_payout:<bank id> /
-- stripe_session:<session id>.
--
-- Positions are what the ledger and the provider each say about the money,
-- in cents, at the moment the run looked:
--   held     money on its way out (Payouts in flight / the bank's "processing")
--   settled  money that has left (Bank payouts / paid out at the bank), or
--            for Stripe, money collected and credited to a user
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID        NOT NULL REFERENCES reconciliation_runs(id),
  break_key               TEXT        NOT NULL,
  object_type             TEXT        NOT NULL CHECK (object_type IN ('payout', 'deposit')),
  object_id               UUID,
  account_id              UUID        REFERENCES accounts(id),
  provider_ref            TEXT,
  classification          TEXT        NOT NULL
    CHECK (classification IN ('missing_at_provider', 'missing_in_ledger', 'amount_mismatch', 'status_mismatch')),
  -- open:          needs a person
  -- auto_resolved: the provider's record settled it, through the same code as a webhook
  -- in_transit:    not a break yet (e.g. a payout the bank has not received, with a retry scheduled)
  -- acknowledged:  a person already resolved exactly this disagreement on an earlier run
  outcome                 TEXT        NOT NULL CHECK (outcome IN ('open', 'auto_resolved', 'in_transit', 'acknowledged')),
  currency                CHAR(3)     NOT NULL,
  our_status              TEXT,
  provider_status         TEXT,
  our_amount_cents        BIGINT,
  provider_amount_cents   BIGINT,
  ledger_held_cents       BIGINT      NOT NULL,
  ledger_settled_cents    BIGINT      NOT NULL,
  provider_held_cents     BIGINT      NOT NULL,
  provider_settled_cents  BIGINT      NOT NULL,
  -- What the run did on its own, and the ledger transfers that did it.
  auto_action             TEXT,
  auto_transfer_ids       UUID[]      NOT NULL DEFAULT '{}',
  -- sha256 of the disagreement (classification, statuses, amounts, positions).
  -- A resolution settles one fingerprint; if anything changes, it is new.
  fingerprint             TEXT        NOT NULL,
  detail                  TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_items_once_per_run UNIQUE (run_id, break_key)
);
CREATE INDEX reconciliation_items_break_idx ON reconciliation_items (break_key, created_at DESC);
CREATE TRIGGER reconciliation_items_append_only BEFORE UPDATE OR DELETE ON reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- reconciliation_resolutions: a person's decision, with their note.
--
--   accept_provider   the provider is right: post the transfers that bring the
--                     ledger to the provider's position
--   accept_ours       our ledger is right (e.g. the provider confirmed an error
--                     on their side): no money moves, the disagreement is noted
--   acknowledge_flag  a payout the bank contradicted, looked at, where the
--                     money already agrees: no money moves
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_resolutions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID        REFERENCES reconciliation_items(id),
  payout_id     UUID        REFERENCES payouts(id),
  break_key     TEXT        NOT NULL,
  fingerprint   TEXT        NOT NULL,
  action        TEXT        NOT NULL CHECK (action IN ('accept_provider', 'accept_ours', 'acknowledge_flag')),
  -- For accept_provider: who gives or receives what is left after moving
  -- money between our own control accounts. 'user' is the payout's or
  -- deposit's account; 'platform' is the Reconciliation adjustments account
  -- (a loss or gain the business absorbs).
  counterparty  TEXT        CHECK (counterparty IN ('user', 'platform')),
  note          TEXT        NOT NULL CHECK (length(btrim(note)) >= 3),
  resolved_by   TEXT        NOT NULL CHECK (length(btrim(resolved_by)) >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One decision per item: a double-click, or two people at once, resolve it once.
  CONSTRAINT reconciliation_resolutions_one_per_item UNIQUE (item_id),
  CONSTRAINT reconciliation_resolutions_target CHECK (
    (action = 'acknowledge_flag') = (item_id IS NULL) AND (action <> 'acknowledge_flag' OR payout_id IS NOT NULL))
);
CREATE UNIQUE INDEX reconciliation_resolutions_one_ack_per_flag
  ON reconciliation_resolutions (payout_id, fingerprint) WHERE action = 'acknowledge_flag';
CREATE INDEX reconciliation_resolutions_break_idx ON reconciliation_resolutions (break_key, fingerprint);
CREATE TRIGGER reconciliation_resolutions_append_only BEFORE UPDATE OR DELETE ON reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION append_only();

CREATE TABLE reconciliation_resolution_postings (
  resolution_id  UUID NOT NULL REFERENCES reconciliation_resolutions(id),
  transfer_id    UUID NOT NULL REFERENCES transfers(id),
  PRIMARY KEY (resolution_id, transfer_id),
  CONSTRAINT reconciliation_postings_transfer_once UNIQUE (transfer_id)
);
CREATE TRIGGER reconciliation_resolution_postings_append_only BEFORE UPDATE OR DELETE ON reconciliation_resolution_postings
  FOR EACH ROW EXECUTE FUNCTION append_only();
