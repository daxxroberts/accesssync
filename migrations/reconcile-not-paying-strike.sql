-- Reconciliation safety pass (2026-09-10): not-paying strike clock on
-- member_access_sources.
--
-- Why: the sweep must never remove a member on one bad Wix read. Before a removal
-- is allowed (Phase 3b), the member's plan has to have been seen as not paying for
-- long enough (about 2 days) across enough separate sweeps. These three columns
-- are that clock, kept per (member access, source plan):
--   not_paying_since         when the sweep first saw this plan as not paying,
--                            in the current unbroken run of such sightings.
--   not_paying_last_seen_at  the most recent sweep that saw it as not paying.
--   not_paying_observations  how many sweeps have seen it as not paying since
--                            not_paying_since.
-- Any sweep that sees the plan as paying again resets all three (NULL, NULL, 0).
--
-- Only the L3 primitives in adapters/standard-adapter.js write them
-- (recordNotPayingObservation / clearNotPayingObservation, DR-023). They update
-- these columns only: never status, never updated_at. In Phase 1 the clock only
-- records; nothing reads it to remove anyone.
--
-- ADD COLUMN IF NOT EXISTS with a constant DEFAULT is metadata-only on Postgres 11+
-- (no table rewrite): existing rows read as NULL / NULL / 0, a clock that has not
-- started. No backfill statement is needed, and none is included. All three
-- columns are added in one ALTER TABLE, so they arrive (and leave) together.
--
-- Idempotent: every ADD COLUMN is IF NOT EXISTS, and COMMENT ON just overwrites.
-- Additive and reversible: three new columns, no existing data changed. Rollback
-- is reconcile-not-paying-strike.rollback.sql.
--
-- ORDER: either. If the code ships first, its UPDATE fails on the missing column
-- (Postgres 42703), the primitive logs adapter.not_paying.columns_missing once and
-- returns without recording, and no strike clock ever starts. A clock that never
-- starts means the member is never eligible for automatic removal: fail safe.
--
-- Applied to Supabase gklgwyrnkedebyulrclv 2026-09-11.

ALTER TABLE member_access_sources
  ADD COLUMN IF NOT EXISTS not_paying_since        TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS not_paying_last_seen_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS not_paying_observations INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN member_access_sources.not_paying_since IS
  'Strike clock: when the reconciliation sweep first saw this source''s plan as not '
  'paying in Wix, in the current unbroken run of such sightings. NULL = not started. '
  'Written only by the L3 not-paying primitives; reset when the plan is seen paying.';

COMMENT ON COLUMN member_access_sources.not_paying_last_seen_at IS
  'Strike clock: the most recent reconciliation sweep that saw this source''s plan as '
  'not paying in Wix. NULL = not started.';

COMMENT ON COLUMN member_access_sources.not_paying_observations IS
  'Strike clock: how many reconciliation sweeps have seen this source''s plan as not '
  'paying in Wix since not_paying_since. 0 = not started. Automatic removal needs both '
  'enough time and enough observations.';
