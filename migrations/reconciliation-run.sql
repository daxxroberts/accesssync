-- Reconciliation hardening for HOG launch
-- Adds: per-run audit table + last_active_member_count for sanity gate
-- Issue context: docs/OPERATOR_FAQ.md ("Why does AccessSync revoke...")

-- 1. Run-level audit. One row per sweep run (cron OR manual OR per-member).
CREATE TABLE IF NOT EXISTS reconciliation_run (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trace_id                 VARCHAR(64),
  triggered_by             VARCHAR(32) NOT NULL,           -- 'cron' | 'manual' | 'member_sync'
  triggered_by_actor_type  VARCHAR(32),                    -- 'system' | 'operator' | 'member' | NULL
  triggered_by_actor_id    VARCHAR(128),                   -- operator user id, etc. NULL for cron
  started_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMP WITH TIME ZONE,
  status                   VARCHAR(32) NOT NULL DEFAULT 'running',  -- 'running' | 'success' | 'failed' | 'aborted'
  abort_reason             VARCHAR(64),                    -- 'wix_api_unavailable' | 'sanity_gate_tripped' | etc.
  wix_active_count         INTEGER,                        -- size of wixMembers map at sweep time
  kisi_managed_count       INTEGER,                        -- size of kisiMembers map at sweep time
  grants_queued            INTEGER NOT NULL DEFAULT 0,
  revokes_queued           INTEGER NOT NULL DEFAULT 0,
  grants_skipped_optin     INTEGER NOT NULL DEFAULT 0,     -- holders skipped per opt-in rule
  sanity_gate_triggered    BOOLEAN NOT NULL DEFAULT FALSE,
  sanity_gate_resolved     BOOLEAN,                        -- true = re-query agreed; false = aborted
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_run_client_started ON reconciliation_run (client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_run_trace ON reconciliation_run (trace_id);

-- 2. Last-known active count per client. Used by sanity gate to compute % drop.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS last_active_member_count INTEGER;
