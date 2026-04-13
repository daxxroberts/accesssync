-- migrations/webhook-log-index.sql
-- Fix slow webhook log query (~700ms every 10s from Admin Hub polling)
-- Adds index on received_at DESC so ORDER BY + LIMIT scans only the top rows
-- Also indexes client_id for future client-filter queries
-- CONCURRENTLY means no table lock — safe to run on live DB

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_log_received_at
  ON webhook_log (received_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_log_client_id
  ON webhook_log (client_id);
