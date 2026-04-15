-- reconciliation-interval.sql
-- Adds reconciliation_interval to clients table.
-- Controls how frequently the nightly sweep runs per client.
-- Values: 'hourly', '6h', '12h', 'daily' (default), 'weekly'
-- Safe to re-run: uses IF NOT EXISTS.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS reconciliation_interval VARCHAR(20) DEFAULT 'daily';
