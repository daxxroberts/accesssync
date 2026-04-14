-- migrations/edge-case-health-status.sql
-- Edge case fixes: K-2 (dead Kisi groups) + Wix archived plan detection
-- Safe to run on live DB — no locks, no data loss

-- K-2: Per-group health tracking on plan_mapping_groups
-- Allows marking individual dead groups without deactivating the entire plan mapping.
-- Values: 'ok' (default, live group), 'not_found' (confirmed deleted in hardware platform)
-- Grant loop skips not_found rows. Mapping stays active. Other groups keep working.
ALTER TABLE plan_mapping_groups
  ADD COLUMN IF NOT EXISTS health_status VARCHAR(20) DEFAULT 'ok';

-- Wix archived plan detection
-- Tracks plan lifecycle status from Wix API.
-- Values: 'active' (default), 'archived' (plan archived on Wix)
-- Informational only — archived plans still function until member subscriptions expire naturally.
ALTER TABLE plan_mappings
  ADD COLUMN IF NOT EXISTS wix_status VARCHAR(20) DEFAULT 'active';
