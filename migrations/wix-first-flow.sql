-- Wix-First Flow Migration
-- Enables operators to onboard with Wix before configuring door hardware (Kisi/Seam).
-- Members who arrive via webhook before hardware is configured get 'pending_hardware'
-- state instead of 'failed', and auto-retry when API key is later added.
--
-- Changes:
-- 1. plan_mappings.hardware_group_id: NOT NULL → nullable (allows plan recognition without group mapping)
-- 2. member_access_state.status: document 'pending_hardware' as valid value (VARCHAR, no enum constraint to change)
--
-- Run on Railway Postgres before deploying the Wix-first code.

-- Allow plan mappings to exist without a hardware group assigned yet
ALTER TABLE plan_mappings ALTER COLUMN hardware_group_id DROP NOT NULL;

-- Store the source plan ID on pending_hardware members so we can re-enqueue them
-- when the API key or group mapping is later configured.
ALTER TABLE member_access_state ADD COLUMN pending_plan_id VARCHAR(255);
