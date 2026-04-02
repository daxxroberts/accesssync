-- DR-035: Platform-agnostic schema normalization
-- Renames Kisi-specific column names to platform-agnostic equivalents.
-- Required before any second hardware or membership platform adapter is built.
--
-- Run once on Railway Postgres BEFORE deploying the DR-035 code commit.
-- Safe to inspect first: these are pure renames — no data is changed.

-- Rename hardware API key columns: kisi_api_key → hardware_api_key
-- Applies to both clients (org-level default) and locations (override).
ALTER TABLE clients   RENAME COLUMN kisi_api_key TO hardware_api_key;
ALTER TABLE locations RENAME COLUMN kisi_api_key TO hardware_api_key;

-- Rename plan mapping plan ID column: wix_plan_id → source_plan_id
-- Allows non-Wix membership platforms to store their plan/product IDs
-- in the same column without schema confusion.
ALTER TABLE plan_mappings RENAME COLUMN wix_plan_id TO source_plan_id;
