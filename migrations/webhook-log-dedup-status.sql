-- Migration: webhook-log-dedup-status.sql
-- Adds dedup_status column to webhook_log table.
-- This column exists in schema.sql but was never applied to the live Railway DB.
-- Required by: admin/routes/members.js, admin/routes/operator.js (latency queries),
--              admin/routes/webhooks.js (Webhook Inspector), core/webhook-processor.js
-- Values: 'new' | 'duplicate' | NULL (if rejected before dedup check)

ALTER TABLE webhook_log
  ADD COLUMN IF NOT EXISTS dedup_status VARCHAR(20);
