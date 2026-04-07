-- Per-location config: hardware_platform + notification_email
-- Run on Railway Postgres before deploying the System Config restructure code.
-- Both columns are nullable — fallback to clients table values via COALESCE in app code.

ALTER TABLE locations ADD COLUMN hardware_platform VARCHAR(50);
ALTER TABLE locations ADD COLUMN notification_email VARCHAR(255);
