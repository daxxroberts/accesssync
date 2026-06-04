-- F-16: Wix App Market operator-billing columns on billing_subscriptions
--
-- Applied to live Supabase project gklgwyrnkedebyulrclv via
-- mcp__claude_ai_Supabase__apply_migration with name
-- 'f_16_billing_subscriptions_wix_app_market_columns'. This file is the
-- repo mirror -- kept in sync so the migrations/ ledger reflects production.
--
-- Adds two columns required by OB-66 (operator-side Wix App Market billing
-- webhook handler):
--
--   vendor_product_id     Opaque Wix-assigned plan identifier carried in the
--                         Paid Plan Purchased / Changed JWT payload. THE tier
--                         identifier from Wix's side; mapped to AccessSync tier
--                         names via the OB-72 mapping (design TBD).
--
--   wix_app_instance_id   Site-scoped app install ID extracted from the signed
--                         JWT at install time (App Instance Installed event).
--                         Persisted so AccessSync can iterate stored IDs to call
--                         GET /apps/v1/instance (no list-instances endpoint exists)
--                         and reconcile trial->paid transitions (no webhook fires
--                         for that conversion -- see F-18 poll job).
--
-- Auth context: Wix App Market webhooks are JWT-signed (verified against
-- WIX_APP_PUBLIC_KEY, F-17), distinct from member-level Pricing Plans webhooks
-- which use HMAC (WIX_WEBHOOK_SECRET).
--
-- HOG impact: NONE. HOG is a Velo direct install (DR-016) -- no App Market
-- webhook ever fires. HOG's billing_subscriptions row is a manual placeholder
-- and these new columns will remain NULL on it indefinitely. Migration is
-- additive-only: both columns nullable, no defaults, no constraints, safe
-- to apply on live DB.
--
-- See memory: reference_wix_app_market_billing.md (PARSE 2026-05-12).

ALTER TABLE billing_subscriptions
  ADD COLUMN IF NOT EXISTS vendor_product_id   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS wix_app_instance_id VARCHAR(255);

COMMENT ON COLUMN billing_subscriptions.vendor_product_id IS
  'OB-66 / F-16 -- Opaque Wix-assigned Plan ID from the Paid Plan Purchased JWT '
  '(vendorProductId field). Maps to AccessSync tier names via OB-72 design '
  '(mapping table TBD). NULL for HOG (Velo direct install, DR-016) and any '
  'manually-seeded billing_subscriptions rows.';

COMMENT ON COLUMN billing_subscriptions.wix_app_instance_id IS
  'OB-66 / F-16 -- Site-scoped Wix App Market install ID, extracted from the '
  'signed JWT body at App Instance Installed time. Persisted so we can iterate '
  'stored IDs to call GET /apps/v1/instance (no list-instances endpoint) and '
  'detect trial->paid transitions via F-18 poll job. NULL for HOG.';
