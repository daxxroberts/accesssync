-- Sprint 5: Pre-HOG Safety Net migrations
-- Run once on Railway Postgres BEFORE deploying the Sprint 5 code commit.
-- All statements use IF NOT EXISTS — safe to re-run.

-- 5.2: Kisi health check cron — tracks last successful key validation per location
ALTER TABLE locations ADD COLUMN IF NOT EXISTS hardware_key_last_verified TIMESTAMP WITH TIME ZONE;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS hardware_key_last_error     TEXT;

-- 5.5: First grant experience — tracks whether welcome email has been sent per client
ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_grant_sent BOOLEAN NOT NULL DEFAULT false;
