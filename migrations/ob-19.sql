-- OB-19: DR-027 (per-location subscription model) + DR-028 (Kisi API key storage)
-- Run once on Railway Postgres BEFORE deploying the OB-19/OB-23 code commit.
-- All statements use IF NOT EXISTS — safe to re-run.

-- DR-027: Per-location subscription model
ALTER TABLE locations ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) NOT NULL DEFAULT 'inactive';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS tier              VARCHAR(50);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS subscribed_at     TIMESTAMP WITH TIME ZONE;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS subscription_id   VARCHAR(255);

-- DR-028: Kisi API key storage — org-level default + location-level override
ALTER TABLE clients   ADD COLUMN IF NOT EXISTS kisi_api_key VARCHAR(500);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS kisi_api_key VARCHAR(500);
