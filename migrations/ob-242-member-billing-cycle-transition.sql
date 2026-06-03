-- OB-242 — Multi-cycle billing transition fix.
--
-- Trigger: Daxx Student wix_order_id d2eaf66f-... first auto-renewal landed
-- 2026-06-03 03:47:05 UTC. Wix fired plan.purchased for cycle 2.
-- standard-adapter.completeGrant INSERTed the new cycle 2 row but did NOT
-- transition cycle 1 to a terminal status. Result: two member_billing rows
-- both status='active' for the same wix_subscription_id, which surfaces as
-- a duplicate row in v_active_members + downstream rate displays.
--
-- This migration:
-- 1. Data cleanup — close Daxx's cycle 1 Student row (applied separately as
--    ob_242_cleanup_daxx_student_cycle_1; recorded here for the audit trail).
-- 2. Adds a partial UNIQUE index ensuring at most one active row per
--    (client_id, member_master_id, wix_subscription_id) going forward.
--    Defense-in-depth invariant — forces the code path in completeGrant
--    to transition the prior cycle before INSERTing the new one.

BEGIN;

-- Schema invariant
CREATE UNIQUE INDEX IF NOT EXISTS member_billing_one_active_per_subscription
ON member_billing (client_id, member_master_id, wix_subscription_id)
WHERE status = 'active' AND wix_subscription_id IS NOT NULL;

COMMENT ON INDEX member_billing_one_active_per_subscription IS
  'Defense-in-depth: ensures only one active billing cycle per Wix subscription. Forces standard-adapter.completeGrant to transition prior cycles to terminal status when a new cycle is INSERTed. Filed under the 2026-06-03 Daxx Student cycle 1+2 incident.';

-- Data cleanup (applied 2026-06-03 via mcp ob_242_cleanup_daxx_student_cycle_1).
-- Recorded here for audit. No-op on idempotent re-run.
UPDATE member_billing
SET status = 'completed',
    effective_end = COALESCE(effective_end, '2026-05-03 03:46:12.421+00'::timestamptz),
    updated_at = NOW()
WHERE id = '490c703b-003b-4bdc-b43f-592ca1fff899'
  AND status = 'active'
  AND cycle_index = 1;

COMMIT;
