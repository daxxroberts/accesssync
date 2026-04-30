-- DR-044: Sub-member soft-delete with PII purge
--
-- Terminal state for revoked sub-members. After processRevoke() succeeds
-- (Kisi role removed, member_access_sources rows deleted), the row transitions:
--   sub_member_status = 'deleted'
--   first_name, last_name, display_name, email, phone = NULL
--   updated_at = NOW()
-- Lineage preserved: platform_member_id, plan_holder_id, plan_mapping_id,
-- client_id, hardware_user_id, source_tag, created_at.
--
-- The actual transition is performed by core/grant-revoke.js processRevoke()
-- as a single atomic UPDATE with optimistic-lock WHERE sub_member_status='removing'.
--
-- This migration only handles BACKFILL of pre-existing PII-bearing revoked rows
-- so that DR-001 (no PII storage) is satisfied retroactively.
--
-- Schema-level note: sub_member_status is a free-form VARCHAR(50) per
-- schema.sql:173, not a Postgres ENUM. No DDL changes needed to add the
-- 'deleted' value — code emits it directly.
--
-- Safe to run on live DB. The 5-minute updated_at guard prevents the
-- backfill from racing live revoke jobs (the application-level finalize
-- runs immediately after revoke completes, so any row updated within the
-- last 5 minutes is potentially mid-flight).

BEGIN;

UPDATE member_identity
SET sub_member_status = 'deleted',
    first_name   = NULL,
    last_name    = NULL,
    display_name = NULL,
    email        = NULL,
    phone        = NULL,
    updated_at   = NOW()
WHERE plan_holder_id IS NOT NULL
  AND sub_member_status IN ('removing', 'revoked')
  AND updated_at < NOW() - INTERVAL '5 minutes';

-- Verification query (run manually after migration):
--   SELECT sub_member_status, COUNT(*) AS rows,
--          COUNT(first_name) AS still_have_first_name,
--          COUNT(email)      AS still_have_email
--   FROM member_identity
--   WHERE plan_holder_id IS NOT NULL
--   GROUP BY sub_member_status
--   ORDER BY sub_member_status;
--
-- Expected: 'deleted' rows show 0 in still_have_first_name and still_have_email.
-- 'removing' rows (if any) are the in-flight ones the 5-min guard skipped —
-- they will finalize on their next processRevoke() success per DR-044 logic.

COMMIT;
