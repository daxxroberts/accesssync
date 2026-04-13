-- diagnostic-log.sql
-- Structured observability table for AI-powered failure analysis.
-- Additive migration — no existing tables modified.
-- Run on Railway Postgres before deploying the observability code commit.

CREATE TABLE IF NOT EXISTS diagnostic_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Tenant scope. NULL = platform-level event (HMAC spike with unresolved client,
    -- worker crash, etc.)
    client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,

    -- Which code layer fired this event.
    -- e.g. 'wix-plans-api', 'kisi-connector', 'queue-worker', 'hmac-monitor', 'grant-revoke'
    service     VARCHAR(100) NOT NULL,

    -- Severity tier. Only warn/error/critical rows are written to this table.
    -- info/debug stay stdout-only to keep write volume low.
    level       VARCHAR(20) NOT NULL CHECK (level IN ('warn', 'error', 'critical')),

    -- Machine-readable error code from the KEDB.
    -- e.g. 'WIX_KEY_INVALID', 'KISI_RATE_LIMIT', 'HMAC_FAILURE', 'PLAN_NOT_MAPPED'
    error_code  VARCHAR(100) NOT NULL,

    -- Human-readable description — operator-safe (no raw stack traces).
    message     TEXT NOT NULL,

    -- Arbitrary structured context: HTTP status, memberId, planId, traceId, endpoint, etc.
    context     JSONB DEFAULT '{}',

    -- Set by operator via Admin Hub "Mark resolved" action. NULL = still open.
    resolved_at TIMESTAMPTZ
);

-- Primary query: all open issues for a client, newest first.
CREATE INDEX IF NOT EXISTS idx_diagnostic_log_client_created
    ON diagnostic_log (client_id, created_at DESC)
    WHERE resolved_at IS NULL;

-- AI summary + Admin Hub filter by error code.
CREATE INDEX IF NOT EXISTS idx_diagnostic_log_client_code
    ON diagnostic_log (client_id, error_code, created_at DESC);

-- Platform-level events (client_id IS NULL) — HMAC spikes, worker crashes.
CREATE INDEX IF NOT EXISTS idx_diagnostic_log_platform
    ON diagnostic_log (created_at DESC)
    WHERE client_id IS NULL;
