-- OB-244: Add DR-044 sub-member lifecycle states ('removing', 'deleted') to
-- member_access.status CHECK constraint.
--
-- Applied live to Supabase as migration ob_244_member_access_status_dr_044_states
-- on 2026-06-07. This file is the repo mirror for audit + regression test fixture.
--
-- Trigger: 500 on DELETE /api/multi-member/members/:subId when handler attempts
-- UPDATE member_access SET status='removing' on an active sub-member with a Kisi
-- user. The post-S-11 CHECK constraint (OB-202 widened to 5 values) never picked
-- up DR-044's terminal states ('removing' transitional, 'deleted' terminal post
-- PII purge). Code, UI badges, operator filters, and tests all expected both
-- values to be valid on the new member_access table — only the constraint was
-- out of sync. Non-destructive widen, no data migration required (no rows
-- currently violate).

ALTER TABLE member_access DROP CONSTRAINT member_access_status_check;

ALTER TABLE member_access ADD CONSTRAINT member_access_status_check
  CHECK (status IN (
    'active',
    'inactive',
    'in_flight',
    'pending_identity',
    'recovery_pending',
    'removing',
    'deleted'
  ));

COMMENT ON COLUMN member_access.status IS
  'Per-person access state (DR-046). Values: active (>=1 source active), inactive (0 sources active), in_flight (lock held during write), pending_identity (Wix resolve ladder failed, awaiting retry), recovery_pending (OB-202 transient retry state after stale-lock cleanup), removing (DR-044 sub-member soft-delete in flight — Kisi revoke queued), deleted (DR-044 terminal — PII purged, lineage preserved).';
