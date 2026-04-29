-- dr-042-backfill.sql
-- DR-042: backfill billing_snapshot from existing webhook_log rows.
--
-- Run AFTER dr-042.sql applies (which adds the column).
-- Run AFTER deploying code that reads/writes billing_snapshot (otherwise the
-- backfill is overwritten by the next no-snapshot grant pass).
-- Idempotent — only updates rows where billing_snapshot IS NULL.
-- Safe to run multiple times.
--
-- Strategy: for each member with at least one MRA, find their most recent
-- plan.purchased webhook payload, extract the canonical snapshot fields
-- via JSONB paths, and write to every MRA row for that member.
--
-- Existing HOG members get their snapshots populated immediately. Future
-- renewals refresh the snapshot via the live grant path (queue-worker.js
-- → standardAdapter.completeGrant with billingSnapshot arg).

BEGIN;

WITH latest_orders AS (
  SELECT DISTINCT ON (mi.id)
    mi.id                              AS member_id,
    wl.raw_payload->'data'->'entity'   AS entity,
    wl.received_at                     AS captured_at
  FROM   webhook_log    wl
  JOIN   member_identity mi
    ON   mi.client_id          = wl.client_id
    AND  mi.platform_member_id = wl.normalized_payload->>'platformMemberId'
  WHERE  wl.normalized_payload->>'eventType' = 'plan.purchased'
    AND  wl.hmac_status  = 'accepted'
    AND  wl.dedup_status = 'new'
    AND  wl.raw_payload->'data'->'entity' IS NOT NULL
  ORDER  BY mi.id, wl.received_at DESC
)
UPDATE member_role_assignments mra
SET    billing_snapshot = jsonb_strip_nulls(jsonb_build_object(
         'planPrice',         lo.entity->>'planPrice',
         'cycleUnit',         lo.entity->'pricing'->'subscription'->'cycleDuration'->>'unit',
         'cycleCount',        NULLIF(lo.entity->'pricing'->'subscription'->'cycleDuration'->>'count', '')::int,
         'currency',          lo.entity->'pricing'->'prices'->0->'price'->>'currency',
         'total',             lo.entity->'pricing'->'prices'->0->'price'->>'total',
         'subtotal',          lo.entity->'pricing'->'prices'->0->'price'->>'subtotal',
         'discount',          lo.entity->'pricing'->'prices'->0->'price'->>'discount',
         'coupon',            CASE
                                WHEN lo.entity->'pricing'->'prices'->0->'price'->'coupon'->>'code' IS NOT NULL
                                THEN jsonb_build_object(
                                  'code',   lo.entity->'pricing'->'prices'->0->'price'->'coupon'->>'code',
                                  'amount', lo.entity->'pricing'->'prices'->0->'price'->'coupon'->>'amount'
                                )
                                ELSE NULL
                              END,
         'autoRenewCanceled', COALESCE((lo.entity->>'autoRenewCanceled')::bool, false),
         'lastPaymentStatus', lo.entity->>'lastPaymentStatus',
         'subscriptionId',    lo.entity->>'subscriptionId',
         'orderMethod',       lo.entity->>'orderMethod',
         'orderId',           lo.entity->>'_id',
         'capturedAt',        to_char(lo.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ))
FROM   latest_orders lo
WHERE  mra.member_id        = lo.member_id
  AND  mra.billing_snapshot IS NULL;

-- Diagnostic: how many rows did we just populate?
DO $$
DECLARE
  populated INT;
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO populated FROM member_role_assignments WHERE billing_snapshot IS NOT NULL;
  SELECT COUNT(*) INTO remaining FROM member_role_assignments WHERE billing_snapshot IS NULL;
  RAISE NOTICE 'DR-042 backfill: % MRA rows have billing_snapshot, % still NULL', populated, remaining;
END $$;

COMMIT;
