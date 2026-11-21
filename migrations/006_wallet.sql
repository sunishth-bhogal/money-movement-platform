-- Stage 6 (user dashboard): indexes for a user's own activity feed.
--
-- The wallet lists a user's transfers by either side. Until now transfers
-- were only ever looked up by id or idempotency key, so these were not needed.
CREATE INDEX transfers_from_account_idx ON transfers (from_account_id, created_at DESC);
CREATE INDEX transfers_to_account_idx ON transfers (to_account_id, created_at DESC);
