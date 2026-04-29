-- dr-042.sql
-- DR-042: billing_snapshot on member_role_assignments
--
-- Problem: the operator Members page needs to display per-member billing
-- (plan rate, coupon, auto-renew status, subscription ID) on every render.
-- The data lives only in webhook_log.raw_payload (jsonb). Extracting it on
-- every page load via JSONB path queries is wasteful and re-derives a value
-- that is fully determined at grant time.
--
-- Solution: snapshot the billing fields onto member_role_assignments at grant
-- time. One row per member-per-mapping already exists; billing fits the grain
-- exactly. Snapshot is rewritten on every grant pass — Wix's orderUpdated →
-- plan.purchased flow keeps it current with renewals automatically.
--
-- Snapshot shape (defined in core/billing-snapshot.js, not enforced by DB):
--   { planPrice, cycleUnit, cycleCount, currency, total, subtotal, discount,
--     coupon: { code, amount } | null, autoRenewCanceled, lastPaymentStatus,
--     subscriptionId, orderMethod, orderId, capturedAt }
--
-- Additive, idempotent. Column nullable — existing rows stay NULL until
-- the next grant or until dr-042-backfill.sql runs.
-- Safe to run against live Railway DB.

BEGIN;

ALTER TABLE member_role_assignments
  ADD COLUMN IF NOT EXISTS billing_snapshot jsonb;

COMMENT ON COLUMN member_role_assignments.billing_snapshot IS
  'Billing fields extracted from the latest plan.purchased webhook payload. '
  'Written by core/grant-revoke.js at grant time; refreshed on every renewal. '
  'Shape canonicalised in core/billing-snapshot.js. Display-only — never used '
  'as a source of truth for grant decisions.';

COMMIT;
