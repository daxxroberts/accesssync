-- observability-trace-id.sql
-- Adds trace_id to webhook_log and diagnostic_log for end-to-end lifecycle correlation.
-- Forward-only: NULL for all pre-migration rows (no backfill needed).
-- Safe to run while old code is deployed — old INSERT statements ignore the column.

ALTER TABLE webhook_log    ADD COLUMN IF NOT EXISTS trace_id VARCHAR(36);
ALTER TABLE diagnostic_log ADD COLUMN IF NOT EXISTS trace_id VARCHAR(36);

-- Partial indexes — only index rows that actually have a trace_id.
CREATE INDEX IF NOT EXISTS idx_webhook_log_trace_id
    ON webhook_log (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diagnostic_log_trace_id
    ON diagnostic_log (trace_id) WHERE trace_id IS NOT NULL;
