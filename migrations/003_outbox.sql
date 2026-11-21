-- Stage 3 (reliability): transactional outbox, and idempotency-key scopes.

-- ---------------------------------------------------------------------------
-- outbox
-- Every state change that the outside world needs to hear about (a transfer
-- posted, a deposit credited) writes one row here IN THE SAME TRANSACTION as
-- the change itself. So "money moved but nobody was told" and "we announced a
-- transfer that rolled back" are both impossible: the row and the change
-- commit together or not at all.
--
-- A separate worker (src/outbox/worker.ts) publishes rows after commit, with
-- retries. Delivery is at-least-once, so event_id is the stable id consumers
-- deduplicate on.
--
-- Lifecycle:
--   pending ──(published)──► published
--      │ ▲
--      │ └─(failed, attempts left: next_attempt_at = now() + backoff)
--      └───(attempts exhausted, or a permanent error)──► dead
--
-- A worker claims a row by pushing next_attempt_at forward by its lease and
-- setting claim_token. If the worker crashes, the lease simply runs out and
-- the row is due again. No separate "in_progress" status can get stuck.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id               BIGSERIAL   PRIMARY KEY,
  event_id         UUID        NOT NULL DEFAULT gen_random_uuid(),
  event_type       TEXT        NOT NULL,              -- e.g. transfer.posted, deposit.succeeded
  aggregate_type   TEXT        NOT NULL,              -- transfer | deposit
  aggregate_id     UUID        NOT NULL,
  payload          JSONB       NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
  attempts         INT         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- When the row is next eligible to be claimed. Doubles as the lease while a
  -- worker holds it, and as the backoff timer after a failure.
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set by the worker that currently holds the lease. Completing or failing a
  -- row requires the matching token, so a worker whose lease expired (and was
  -- taken over) cannot overwrite the newer worker's result.
  claim_token      UUID,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at     TIMESTAMPTZ,
  CONSTRAINT outbox_event_id_unique UNIQUE (event_id),
  CONSTRAINT outbox_published_iff_timestamp CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT outbox_claim_only_while_pending CHECK (status = 'pending' OR claim_token IS NULL)
);

-- The worker's only query path: due pending rows, oldest first. Partial, so
-- published history doesn't bloat it.
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_type, aggregate_id);

-- ---------------------------------------------------------------------------
-- Idempotency-key scopes for transfers.
-- Keys used to be one global namespace shared by API clients and internal
-- code. The deposit webhook posts its ledger transfer under the key
-- `deposit:<deposit id>`, and a client could send that same string as its own
-- Idempotency-Key first. The webhook would then hit "key reused with a
-- different body" and fail on every retry, so the deposit could never be
-- credited. Client keys and internal keys now live in separate scopes.
-- ---------------------------------------------------------------------------
ALTER TABLE transfers
  ADD COLUMN idempotency_scope TEXT NOT NULL DEFAULT 'api' CHECK (idempotency_scope IN ('api', 'system'));

UPDATE transfers t
   SET idempotency_scope = 'system'
 WHERE EXISTS (SELECT 1 FROM deposits d WHERE d.transfer_id = t.id);

ALTER TABLE transfers DROP CONSTRAINT transfers_idempotency_key_unique;
ALTER TABLE transfers
  ADD CONSTRAINT transfers_idempotency_key_unique UNIQUE (idempotency_scope, idempotency_key);
