-- error-queue-v2.sql
-- Adds structured error fields to error_queue.
-- Additive only — no existing columns altered, no data dropped.
-- Safe to run on a live database.
-- Run BEFORE deploying error-handling code changes.
--
-- Adds:
--   error_code       — structured error code (HARDWARE_KEY_INVALID etc.)
--   user_message     — humanized message from the connector (was only in email, now persisted)
--   resolution       — enum: ROTATE_API_KEY, RETRY, REMAP_PLAN, CHECK_PERMISSIONS
--   action_text      — the "what to do" instruction string
--   http_status      — HTTP status code from the hardware/Wix API response
--   raw_api_body     — full JSON response body from the API (for debugging)
--   occurred_count   — how many times this same error recurred (dedup grouping)
--   last_occurred_at — timestamp of most recent occurrence (for grouped display)

ALTER TABLE error_queue
  ADD COLUMN IF NOT EXISTS error_code       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS user_message     TEXT,
  ADD COLUMN IF NOT EXISTS resolution       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS action_text      TEXT,
  ADD COLUMN IF NOT EXISTS http_status      INTEGER,
  ADD COLUMN IF NOT EXISTS raw_api_body     JSONB,
  ADD COLUMN IF NOT EXISTS occurred_count   INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurred_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Supports dedup UPSERT in retry-engine.js
-- (lookup by client_id + member_id + error_code for in-flight dedup)
CREATE INDEX IF NOT EXISTS idx_error_queue_dedup
  ON error_queue (client_id, member_id, error_code)
  WHERE status = 'failed';

-- Supports the errors summary endpoint (breakdown by code per client)
CREATE INDEX IF NOT EXISTS idx_error_queue_client_code
  ON error_queue (client_id, error_code, status);
