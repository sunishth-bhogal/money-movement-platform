-- Stage 7 (product): ticketed events, and payouts to the organizers who run them.
--
-- A customer buys tickets through Stripe Checkout. The platform keeps a fee,
-- and the rest is owed to the event's organizers (split between them when an
-- event is co-hosted). That money is held until the event has happened, then
-- released to the organizer's available balance and paid out through the bank
-- connector. A cancelled event refunds its customers; a dispute after payout
-- can leave an organizer owing money.
--
-- Every cent an organizer is owed sits in one of two ledger accounts:
--
--   held       (kind organizer_held) proceeds of events that have not happened
--              yet. Refunds come out of it first. Never negative: the database
--              refuses it, like a user balance.
--   available  (kind organizer) released proceeds, ready to pay out. MAY go
--              negative: a refund or dispute after the money was paid out means
--              the organizer owes us. That is a real state of the business, so
--              the ledger shows it instead of hiding it.
--
--   Stripe clearing ──sale──► held ──fee──► Platform fees
--                              │ └─refund─► Refunds in flight ──► Refunded through Stripe
--                              └─release (after the event)─► available ──payout─► Payouts in flight ──► Bank payouts
--
-- And one rule ties it together, enforced below: every ledger entry on an
-- organizer's account has an organizer_postings row saying why (which event,
-- order, ticket, refund, dispute, payout or decision). The organizer's payout
-- statement is built from those rows, so it cannot leave anything out.

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('user', 'system', 'organizer_held', 'organizer'));
ALTER TABLE accounts DROP CONSTRAINT user_balance_non_negative;
ALTER TABLE accounts ADD CONSTRAINT balance_non_negative
  CHECK (kind IN ('system', 'organizer') OR balance_cents >= 0);

-- ---------------------------------------------------------------------------
-- organizers
-- ---------------------------------------------------------------------------
CREATE TABLE organizers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL CHECK (length(btrim(name)) >= 1),
  currency              CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Where payouts go. The mock bank decides the outcome from the last four digits.
  bank_account_number   TEXT        NOT NULL CHECK (bank_account_number ~ '^\d{4,17}$'),
  held_account_id       UUID        NOT NULL UNIQUE REFERENCES accounts(id),
  available_account_id  UUID        NOT NULL UNIQUE REFERENCES accounts(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizers_two_accounts CHECK (held_account_id <> available_account_id)
);

-- ---------------------------------------------------------------------------
-- events, who hosts them, and what they sell
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL CHECK (length(btrim(name)) >= 1),
  venue            TEXT        NOT NULL DEFAULT '',
  currency         CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  -- The platform fee on each ticket: fee_bps of the price, plus a fixed part.
  -- It is taken from the organizer's proceeds; the customer pays the ticket price.
  fee_bps          INT         NOT NULL DEFAULT 500 CHECK (fee_bps BETWEEN 0 AND 10000),
  fee_fixed_cents  INT         NOT NULL DEFAULT 50 CHECK (fee_fixed_cents >= 0),
  -- Proceeds are released this long after the event ends (time for complaints
  -- and refunds to arrive before the money leaves).
  hold_hours       INT         NOT NULL DEFAULT 48 CHECK (hold_hours >= 0),
  -- Share of an organizer's held proceeds they may take before the event (an
  -- advance). 0 = none. An advance is what makes a cancellation expensive.
  advance_bps      INT         NOT NULL DEFAULT 0 CHECK (advance_bps BETWEEN 0 AND 10000),
  status           TEXT        NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale', 'cancelled')),
  cancelled_at     TIMESTAMPTZ,
  cancel_reason    TEXT,
  -- Set once, when the held proceeds were released to the organizers.
  released_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_ends_after_start CHECK (ends_at >= starts_at),
  CONSTRAINT events_cancelled_has_time CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT events_cancelled_never_released CHECK (status <> 'cancelled' OR released_at IS NULL)
);
CREATE INDEX events_release_due_idx ON events (ends_at) WHERE status = 'on_sale' AND released_at IS NULL;

-- Who gets the proceeds, in basis points. The shares of one event add up to
-- 10000 (checked when the event is created, in one transaction).
CREATE TABLE event_organizers (
  event_id      UUID NOT NULL REFERENCES events(id),
  organizer_id  UUID NOT NULL REFERENCES organizers(id),
  share_bps     INT  NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  PRIMARY KEY (event_id, organizer_id)
);
CREATE INDEX event_organizers_organizer_idx ON event_organizers (organizer_id);

CREATE TABLE ticket_types (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID        NOT NULL REFERENCES events(id),
  name         TEXT        NOT NULL CHECK (length(btrim(name)) >= 1),
  price_cents  BIGINT      NOT NULL CHECK (price_cents > 0),
  capacity     INT         NOT NULL CHECK (capacity > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_types_name_unique UNIQUE (event_id, name)
);

-- ---------------------------------------------------------------------------
-- orders: one Stripe Checkout payment for one or more tickets.
--
-- The same state machine as a deposit, moved only by a verified Stripe webhook
-- (or reconciliation reading Stripe's records):
--
--   created ──► pending ──(paid)──────────────────► paid
--                  │  └─(async method)► processing ─┬► paid
--                  │                                └► failed     (tickets released)
--                  └─(session expired)──────────────► expired     (tickets released)
--   paid with the wrong amount ──────────────────────► requires_review
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key             TEXT        NOT NULL,
  request_hash                TEXT        NOT NULL,
  event_id                    UUID        NOT NULL REFERENCES events(id),
  buyer_name                  TEXT        NOT NULL,
  buyer_email                 TEXT        NOT NULL,
  currency                    CHAR(3)     NOT NULL,
  amount_cents                BIGINT      NOT NULL CHECK (amount_cents > 0),
  fee_cents                   BIGINT      NOT NULL CHECK (fee_cents >= 0 AND fee_cents <= amount_cents),
  status                      TEXT        NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'processing', 'paid', 'failed', 'expired', 'requires_review')),
  stripe_checkout_session_id  TEXT,
  stripe_payment_intent_id    TEXT,
  checkout_url                TEXT,
  failure_reason              TEXT,
  paid_at                     TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT orders_session_unique UNIQUE (stripe_checkout_session_id),
  CONSTRAINT orders_paid_has_time CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
CREATE INDEX orders_event_idx ON orders (event_id, created_at);
CREATE INDEX orders_payment_intent_idx ON orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- One row per seat. Reserved when the order is created (so two buyers cannot
-- both get the last one), valid once paid, released if the payment never comes.
CREATE TABLE tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        NOT NULL REFERENCES orders(id),
  event_id        UUID        NOT NULL REFERENCES events(id),
  ticket_type_id  UUID        NOT NULL REFERENCES ticket_types(id),
  price_cents     BIGINT      NOT NULL CHECK (price_cents > 0),
  fee_cents       BIGINT      NOT NULL CHECK (fee_cents >= 0 AND fee_cents <= price_cents),
  status          TEXT        NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'valid', 'released', 'refunded')),
  refunded_cents  BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= price_cents),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tickets_refunded_in_full CHECK ((status = 'refunded') = (refunded_cents = price_cents))
);
CREATE INDEX tickets_order_idx ON tickets (order_id);
CREATE INDEX tickets_type_idx ON tickets (ticket_type_id) WHERE status IN ('reserved', 'valid');

-- ---------------------------------------------------------------------------
-- refunds: money going back to a customer through Stripe.
--
--   pending ──(Stripe: succeeded)──► succeeded
--      └─────(Stripe: failed)──────► requires_review   (money stays in
--                                     "Refunds in flight"; a person decides)
--
-- The organizer's and the platform's shares come out of their accounts when
-- the refund is created, in the same transaction, and wait in "Refunds in
-- flight" until Stripe confirms. `shares` records the split, so every later
-- refund knows what is left to refund for each organizer.
-- ---------------------------------------------------------------------------
CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   TEXT        NOT NULL,
  request_hash      TEXT        NOT NULL,
  order_id          UUID        NOT NULL REFERENCES orders(id),
  ticket_id         UUID        REFERENCES tickets(id),
  amount_cents      BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency          CHAR(3)     NOT NULL,
  reason            TEXT        NOT NULL CHECK (reason IN ('event_cancelled', 'requested_by_customer', 'organizer_goodwill', 'duplicate')),
  note              TEXT,
  requested_by      TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'requires_review')),
  stripe_refund_id  TEXT,
  failure_reason    TEXT,
  -- [{organizer_id, gross_cents, fee_cents}]: how much of each organizer's
  -- sale this refund reverses, and how much platform fee goes back with it.
  shares            JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT refunds_stripe_id_unique UNIQUE (stripe_refund_id)
);
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- ---------------------------------------------------------------------------
-- disputes: a customer asked their bank to reverse the payment (a chargeback).
-- Stripe takes the disputed amount and a fee from us the moment it opens; we
-- pass both on to the organizer, from held money if the event has not been
-- paid out yet, otherwise from their available balance, which may go negative.
--
--   open ──(won)──► won     (the disputed amount comes back; the fee does not)
--     └───(lost)──► lost    (nothing moves: it already left when it opened)
-- ---------------------------------------------------------------------------
CREATE TABLE disputes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_dispute_id  TEXT        NOT NULL UNIQUE,
  order_id           UUID        NOT NULL REFERENCES orders(id),
  amount_cents       BIGINT      NOT NULL CHECK (amount_cents > 0),
  fee_cents          BIGINT      NOT NULL CHECK (fee_cents >= 0),
  currency           CHAR(3)     NOT NULL,
  reason             TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  shares             JSONB       NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  CONSTRAINT disputes_closed_has_time CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX disputes_order_idx ON disputes (order_id);

-- ---------------------------------------------------------------------------
-- organizer_adjustments: a person changing what an organizer is owed, outside
-- any sale, refund or dispute. Always with a cause and a decision, never edited.
-- ---------------------------------------------------------------------------
CREATE TABLE organizer_adjustments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT       NOT NULL UNIQUE,
  organizer_id   UUID        NOT NULL REFERENCES organizers(id),
  -- Positive: we owe the organizer more. Negative: less.
  amount_cents   BIGINT      NOT NULL CHECK (amount_cents <> 0),
  currency       CHAR(3)     NOT NULL,
  -- Why the money is different (the cause) ...
  cause          TEXT        NOT NULL CHECK (cause IN ('organizer_repaid', 'debt_written_off', 'goodwill_credit', 'correction')),
  -- ... and the decision about it, and who made it.
  note           TEXT        NOT NULL CHECK (length(btrim(note)) >= 3),
  decided_by     TEXT        NOT NULL CHECK (length(btrim(decided_by)) >= 1),
  event_id       UUID        REFERENCES events(id),
  order_id       UUID        REFERENCES orders(id),
  dispute_id     UUID        REFERENCES disputes(id),
  transfer_id    UUID        NOT NULL UNIQUE REFERENCES transfers(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER organizer_adjustments_append_only BEFORE UPDATE OR DELETE ON organizer_adjustments
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- Payouts can now go to an organizer (account_id is then their available account).
-- ---------------------------------------------------------------------------
ALTER TABLE payouts ADD COLUMN organizer_id UUID REFERENCES organizers(id);
ALTER TABLE payouts ADD COLUMN event_id UUID REFERENCES events(id);
CREATE INDEX payouts_organizer_idx ON payouts (organizer_id, created_at) WHERE organizer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- organizer_postings: the reason behind every ledger transfer that touches an
-- organizer's money. One row per transfer, written in the same transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE organizer_postings (
  transfer_id    UUID PRIMARY KEY REFERENCES transfers(id),
  organizer_id   UUID        NOT NULL REFERENCES organizers(id),
  kind           TEXT        NOT NULL CHECK (kind IN (
                   'ticket_sale',       -- + the organizer's share of a ticket sale
                   'platform_fee',      -- − the platform's fee on it
                   'refund',            -- − money back to a customer
                   'fee_returned',      -- + the platform's fee on a refunded or disputed amount, given back
                   'dispute',           -- − a chargeback
                   'dispute_fee',       -- − the fee Stripe charges for a chargeback
                   'dispute_won',       -- + a chargeback reversed in our favour
                   'release',           -- held → available, after the event
                   'advance',           -- held → available, before the event
                   'payout',            -- − paid out to the organizer's bank
                   'payout_failed',     -- + the bank did not pay it out
                   'payout_returned',   -- + the bank paid it out, and it came back
                   'adjustment',        -- ± a person's decision (organizer_adjustments)
                   'reconciliation')),  -- ± a reconciliation resolution
  event_id       UUID        REFERENCES events(id),
  order_id       UUID        REFERENCES orders(id),
  ticket_id      UUID        REFERENCES tickets(id),
  refund_id      UUID        REFERENCES refunds(id),
  dispute_id     UUID        REFERENCES disputes(id),
  payout_id      UUID        REFERENCES payouts(id),
  adjustment_id  UUID        REFERENCES organizer_adjustments(id),
  resolution_id  UUID        REFERENCES reconciliation_resolutions(id),
  memo           TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX organizer_postings_organizer_idx ON organizer_postings (organizer_id, event_id);
CREATE INDEX organizer_postings_order_idx ON organizer_postings (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER organizer_postings_append_only BEFORE UPDATE OR DELETE ON organizer_postings
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- No unexplained money: an entry on an organizer's account commits only if its
-- transfer has a posting row, for that same organizer. Checked at COMMIT, like
-- the double-entry rule, so the posting can be written right after the transfer.
CREATE FUNCTION organizer_entries_explained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND kind IN ('organizer', 'organizer_held'))
     AND NOT EXISTS (
       SELECT 1 FROM organizer_postings p JOIN organizers o ON o.id = p.organizer_id
        WHERE p.transfer_id = NEW.transfer_id AND NEW.account_id IN (o.held_account_id, o.available_account_id)) THEN
    RAISE EXCEPTION 'ledger entry % on organizer account % has no organizer_postings row explaining it', NEW.id, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_organizer_explained
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION organizer_entries_explained();

-- ---------------------------------------------------------------------------
-- Reconciliation knows about ticket orders (Stripe Checkout sessions for
-- tickets), and every decision now names its cause as well as the decision.
-- ---------------------------------------------------------------------------
ALTER TABLE reconciliation_items DROP CONSTRAINT reconciliation_items_object_type_check;
ALTER TABLE reconciliation_items ADD CONSTRAINT reconciliation_items_object_type_check
  CHECK (object_type IN ('payout', 'deposit', 'order'));

-- Why the books and the provider disagreed, as a person concluded. Older
-- resolutions (before this column) have none; the API requires it from now on.
ALTER TABLE reconciliation_resolutions ADD COLUMN cause TEXT
  CHECK (cause IN ('missed_notification', 'provider_error', 'our_error', 'timing', 'fraud_suspected', 'other'));
