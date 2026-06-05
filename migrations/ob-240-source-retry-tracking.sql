-- OB-240 — source-level pending_hardware retry tracking
--
-- Adds three columns to member_access_sources so the scheduled
-- source-retry-probe cron (core/source-retry-probe.js) can track per-row
-- retry state without external bookkeeping.
--
-- Applied live to Supabase project gklgwyrnkedebyulrclv as migration
-- `ob_240_source_retry_tracking` on 2026-06-04.
--
-- Columns:
--   retry_count    INTEGER NOT NULL DEFAULT 0
--     Number of probe attempts for this source row. Bumped each pass.
--     At 3 the row is marked status='failed' and an error_queue row is
--     INSERTed with error_code='SOURCE_RETRY_EXHAUSTED'.
--
--   last_retry_at  TIMESTAMPTZ NULLABLE
--     Timestamp of last probe attempt. The probe's selection query skips
--     rows touched in the last 15 minutes to avoid racing live grants and
--     to keep back-to-back probe runs from double-counting.
--
--   failure_reason TEXT NULLABLE (truncated to 500 chars on write)
--     Most recent retry failure message. NULL on success — operator view
--     surfaces the latest reason for a stuck row.
--
-- DR-023 carve-out: the probe writes directly to member_access_sources
-- instead of routing through standard-adapter.completeGrant. The carve-out
-- is for recovery only (analogous to OB-204's stale-lock recovery primitive)
-- — we explicitly do NOT want to churn member_billing for an
-- already-billed retry. See core/source-retry-probe.js for the inline
-- citation at the UPDATE site.

ALTER TABLE member_access_sources
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN member_access_sources.retry_count IS 'OB-240: number of times source-retry-probe has attempted to re-grant this source row. Bumped each probe pass. At 3 the row is marked failed.';
COMMENT ON COLUMN member_access_sources.last_retry_at IS 'OB-240: timestamp of last source-retry-probe attempt.';
COMMENT ON COLUMN member_access_sources.failure_reason IS 'OB-240: most recent retry failure message (truncated to 500 chars). NULL on success.';
