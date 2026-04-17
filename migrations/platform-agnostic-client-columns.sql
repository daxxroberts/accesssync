-- platform-agnostic-client-columns.sql
-- Platform-agnostic column renames on clients and plan_mappings tables.
--
-- Renames:
--   clients.site_name           → source_site_name   (human-readable source platform site name)
--   clients.site_url            → source_site_url    (source platform site URL)
--   clients.last_wix_webhook_at → last_webhook_at    (last inbound webhook from any source platform)
--   clients.wix_api_key         → source_api_key     (encrypted API key for outbound source platform calls)
--   plan_mappings.wix_status    → source_status      (plan lifecycle status from source platform)
--
-- Run BEFORE deploying any code that references the new column names.
-- Code using old names will crash once this migration runs.
-- Code using new names will crash until this migration runs.
-- Migration order: run this → then deploy code.
--
-- Previously applied renames (already in Railway DB — do not re-run):
--   clients.site_id          → source_site_id         (dr-036 / wix-instance-id.sql)
--   clients.wix_instance_id  → platform_instance_id   (dr-036 / wix-instance-id.sql)

BEGIN;

-- clients table
ALTER TABLE clients RENAME COLUMN site_name           TO source_site_name;
ALTER TABLE clients RENAME COLUMN site_url            TO source_site_url;
ALTER TABLE clients RENAME COLUMN last_wix_webhook_at TO last_webhook_at;
ALTER TABLE clients RENAME COLUMN wix_api_key         TO source_api_key;

-- plan_mappings table
ALTER TABLE plan_mappings RENAME COLUMN wix_status    TO source_status;

COMMIT;
