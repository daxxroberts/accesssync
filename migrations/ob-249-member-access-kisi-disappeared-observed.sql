-- OB-249: Two-strike tracking for Pass 3 operator-deleted-Kisi-user drift detection.
--
-- Applied live to Supabase as migration ob_249_member_access_kisi_disappeared_observed
-- on 2026-06-14. This file is the repo mirror for audit + regression test fixture.
--
-- SAGE condition (2026-06-14 gate): Pass 3 must not take destructive action on a
-- first-observation 404 from Kisi GET /users/:id — could be transient. Two
-- consecutive observations across two sweeps gates the synthetic revoke. First sweep
-- records the timestamp; second sweep sees it set and proceeds with revoke.
--
-- Clears back to NULL on any sweep where the user is present in Kisi again.

ALTER TABLE member_access
  ADD COLUMN IF NOT EXISTS kisi_user_disappeared_observed_at TIMESTAMPTZ;

COMMENT ON COLUMN member_access.kisi_user_disappeared_observed_at IS
  'OB-249: Two-strike marker. Set by reconcile Pass 3 the FIRST time we observe that '
  '''member_access.hardware_user_id'' no longer exists in Kisi. The SECOND consecutive '
  'observation (this column already populated) gates a synthetic revoke. Cleared back to '
  'NULL on any sweep where the user is present again. Prevents single transient 404s from '
  'triggering false revokes during Kisi outages.';
