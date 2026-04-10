-- Migration: wix-instance-id
-- Adds wix_instance_id to clients for Wix portal auth lookup.
-- Keeps site_id for Wix REST API calls (meta-site ID).
-- These are two different Wix identifiers and must be stored separately.

-- 1. Add wix_instance_id column (nullable — existing clients won't have it yet)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS wix_instance_id VARCHAR(255);

-- 2. Add unique index on wix_instance_id (one instance maps to one client)
CREATE UNIQUE INDEX IF NOT EXISTS clients_wix_instance_id_idx
  ON clients (wix_instance_id)
  WHERE wix_instance_id IS NOT NULL;

-- 3. HOG data fix — set wix_instance_id to the actual Wix app instanceId
--    site_id stays as 413432bb (meta-site ID, used for Wix API calls)
UPDATE clients
  SET wix_instance_id = '1a89c38a-d23a-4000-8ad3-c9b999a23dc3'
  WHERE id = '15962eac-c767-46ad-8056-094f35a4a193';
