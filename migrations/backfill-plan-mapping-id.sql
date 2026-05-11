-- =============================================================================
-- backfill-plan-mapping-id.sql
-- =============================================================================
-- One-shot backfill of member_access.plan_mapping_id from member_access_sources.
--
-- Context (2026-05-11):
-- The grant flow was inserting member_access rows with plan_mapping_id = NULL
-- because resolveAndLock() read event.planMappingId — a field never set by the
-- Wix payload parser. The plan_mapping_id was only populated on the downstream
-- member_access_sources row by completeGrant(). Result: 71 of 71 historical
-- rows have member_access.plan_mapping_id IS NULL, and the
-- UNIQUE (member_master_id, plan_mapping_id) constraint was unenforceable
-- because Postgres treats (uuid, NULL) ≠ (uuid, NULL).
--
-- Fix shipped in same sprint (queue-worker.js + standard-adapter.js):
-- planMappingId is now passed explicitly into resolveAndLock and threaded into
-- the INSERT. All future grants will populate member_access.plan_mapping_id.
--
-- Backfill safety (verified 2026-05-11):
--   71 total member_access rows
--   41 with exactly 1 source row              → safe to backfill
--   30 with 0 source rows (parked-mid-grant)  → intentionally stay NULL
--    0 with multiple sources                  → no ambiguity exists
--    0 with sources pointing to different     → no conflict cases exist
--      mapping_ids
--
-- Reversible: UPDATE member_access SET plan_mapping_id = NULL WHERE
-- plan_mapping_id IS NOT NULL AND updated_at >= '2026-05-11';
-- =============================================================================

UPDATE member_access ma
   SET plan_mapping_id = mas.mapping_id,
       updated_at = NOW()
  FROM member_access_sources mas
 WHERE mas.access_id = ma.id
   AND ma.plan_mapping_id IS NULL
   AND mas.mapping_id IS NOT NULL;

-- Sanity report — should show: rows_updated > 0, remaining_null = 30 (parked rows)
SELECT
  COUNT(*) FILTER (WHERE plan_mapping_id IS NOT NULL) AS rows_with_mapping,
  COUNT(*) FILTER (WHERE plan_mapping_id IS NULL)     AS rows_still_null,
  COUNT(*)                                            AS total
FROM member_access;
