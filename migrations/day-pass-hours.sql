-- OB-98 day pass — pass length in hours.
--
-- Wix cannot sell a 1-day plan: the Pricing Plans dashboard floors plan length at
-- 7 days (verified 2026-09-14, support.wix.com "customizing pricing plan durations"),
-- and a Wix Stores order has no end date at all. So the access window is AccessSync's
-- to set, not Wix's: when this column is set on a day-pass mapping, the Kisi group
-- link's valid_until is purchase time + N hours, and the expiry sweep revokes then.
-- Wix's own later orderEnded (a week out on a 7-day plan) lands on an already-revoked
-- pass and is a harmless no-op.
--
-- NULL = fall back to the order's own endDate (the original Pricing-Plans behaviour).
-- Additive and nullable: existing rows and every non-day-pass mapping are untouched.

ALTER TABLE plan_mappings
  ADD COLUMN IF NOT EXISTS day_pass_hours INTEGER;

COMMENT ON COLUMN plan_mappings.day_pass_hours IS
  'OB-98: day-pass access window in hours from purchase (e.g. 24). NULL = use the order end date.';
