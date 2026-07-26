-- Operator alert fatigue — escalate-then-cool-down for the hardware key check.
--
-- The 6-hourly health-check cron had no send suppression: a key that stayed broken
-- re-emailed the operator every single run (4x/day, indefinitely). Builder ruling
-- 2026-07-25: keep the every-6h urgency for the first 24h of a failure (a broken key
-- blocks new signups), then drop to once per day while it stays broken.
--
-- key_first_failed_at  when the current run of failures started (NULL once the key verifies)
-- key_last_alerted_at  when the operator was last emailed about this failure

ALTER TABLE connector_subscriptions
  ADD COLUMN IF NOT EXISTS key_first_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS key_last_alerted_at TIMESTAMPTZ;
