-- ROLLBACK for reconcile-not-paying-strike.sql: removes the three strike-clock
-- columns from member_access_sources.
--
-- WARNING: this resets every running strike clock. That fails safe: a member whose
-- clock is gone has to be seen as not paying all over again before automatic
-- removal could ever apply to them. But the history is lost. Export it first if it
-- matters:
--   SELECT id, access_id, source_plan_id, not_paying_since,
--          not_paying_last_seen_at, not_paying_observations
--     FROM member_access_sources
--    WHERE not_paying_since IS NOT NULL OR not_paying_observations > 0;
--
-- Order: either, but roll the code back first to avoid noise. With the columns
-- gone, a deployed sweep's strike-clock UPDATE fails on the missing column, logs
-- adapter.not_paying.columns_missing once and returns without recording. Nobody's
-- access changes. All three columns are dropped in one ALTER TABLE, so they leave
-- together.

ALTER TABLE member_access_sources
  DROP COLUMN IF EXISTS not_paying_since,
  DROP COLUMN IF EXISTS not_paying_last_seen_at,
  DROP COLUMN IF EXISTS not_paying_observations;
