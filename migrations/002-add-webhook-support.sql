-- AccessSync Migration 002: Add Webhook Support
-- Adds email/display_name to member_identity, dismiss fields to error_queue,
-- and creates the webhook_log table for storing raw inbound webhook events.
-- Engine: PostgreSQL
-- Applied via: npm run migrate

--------------------------------------------------------
-- 1. member_identity: Add email and display_name columns
--------------------------------------------------------

ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

--------------------------------------------------------
-- 2. error_queue: Add dismiss tracking columns
--------------------------------------------------------

ALTER TABLE error_queue
  ADD COLUMN IF NOT EXISTS dismiss_note TEXT,
  ADD COLUMN IF NOT EXISTS dismissed_by VARCHAR(255);

--------------------------------------------------------
-- 3. webhook_log: New table for raw inbound webhook events
--------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID REFERENCES clients(id),
    event_id VARCHAR(255),                  -- Platform-assigned event ID (dedup reference)
    source_platform VARCHAR(50) NOT NULL,   -- 'wix', 'squarespace', etc.
    event_type VARCHAR(100),                -- Normalized event type (e.g. plan.purchased)
    raw_payload JSONB,                      -- Full raw webhook body as received
    normalized_event JSONB,                 -- Adapter-normalized standard event object
    hmac_verified BOOLEAN DEFAULT FALSE,    -- Whether HMAC signature check passed
    processing_status VARCHAR(50) DEFAULT 'received', -- received, enqueued, duplicate, rejected
    rejection_reason TEXT,                  -- Populated if processing_status = 'rejected'
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups by event_id (dedup audit trail)
CREATE INDEX IF NOT EXISTS idx_webhook_log_event_id
  ON webhook_log (event_id);

-- Index for per-client webhook history queries
CREATE INDEX IF NOT EXISTS idx_webhook_log_client_id
  ON webhook_log (client_id);

-- Index for time-range queries (operator dashboard, reconciliation)
CREATE INDEX IF NOT EXISTS idx_webhook_log_received_at
  ON webhook_log (received_at DESC);
