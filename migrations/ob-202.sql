-- OB-202: Add recovery_pending to member_access.status CHECK constraint
-- Trigger: stale-lock cleanup (core/reconciliation.js:80-82) now writes
-- 'recovery_pending' instead of 'inactive' so the row can be picked up by
-- the next reconcile sweep and re-attempted. 'recovery_pending' is a
-- transient state — recovery either succeeds (rolls up to 'active' via
-- standard-adapter CASE expression when sources become active) or times
-- out into normal failure handling.
--
-- Audit trail: SAGE-locked 2026-05-26 in autonomous hardening loop run #2.
-- Survey artifacts captured in changelog 2026-05-26 OB-202 ship entry.

ALTER TABLE member_access
  DROP CONSTRAINT IF EXISTS member_access_status_check;

ALTER TABLE member_access
  ADD CONSTRAINT member_access_status_check
  CHECK (status IN ('active', 'inactive', 'in_flight', 'pending_identity', 'recovery_pending'));
