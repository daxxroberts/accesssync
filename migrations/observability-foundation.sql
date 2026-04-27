-- observability-foundation.sql
-- Logging Foundation Sprint — Step 1
-- DR-037 (Observability Architecture) · DR-038 (Event Registry) · DR-039 (Redaction Allowlist)
--
-- Adds universal trace + actor context columns to all six log tables, creates the
-- new activity_event table for actor-action audit records, and creates v_trace_timeline
-- view for unified cross-surface queries.
--
-- Forward-only — NULL-defaulted on all new columns; pre-migration rows stay NULL.
-- Idempotent — uses IF NOT EXISTS / OR REPLACE on every statement.
-- Safe to run while old code is deployed — old INSERT statements ignore the new columns.
--
-- Rollback path: NULL-defaulted columns can stay (no harm). DROP TABLE activity_event
-- and DROP VIEW v_trace_timeline if rolling back fully.
--
-- Verified live DB state 2026-04-27 against gondola.proxy.rlwy.net:27298:
--   * webhook_log.trace_id    → already exists (observability-trace-id.sql)
--   * diagnostic_log.trace_id → already exists (observability-trace-id.sql)
--   * Other 4 tables have NO trace_id, NO actor_type, NO actor_id
--   * activity_event table does NOT exist
--   * v_trace_timeline view does NOT exist

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. webhook_log — add actor columns (trace_id already exists)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE webhook_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE webhook_log ADD COLUMN IF NOT EXISTS actor_id   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_webhook_log_actor
    ON webhook_log (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. diagnostic_log — add actor columns (trace_id already exists)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE diagnostic_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE diagnostic_log ADD COLUMN IF NOT EXISTS actor_id   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_diagnostic_log_actor
    ON diagnostic_log (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. member_access_log — add trace + actor + per-mapping audit columns
-- ────────────────────────────────────────────────────────────────────────────
-- mapping_id and hardware_group_id close the per-mapping audit gap (DR-026 alignment).
-- Without these, the lifecycle log can't answer "which mapping/door did this affect."
ALTER TABLE member_access_log ADD COLUMN IF NOT EXISTS trace_id          VARCHAR(36);
ALTER TABLE member_access_log ADD COLUMN IF NOT EXISTS actor_type        VARCHAR(20);
ALTER TABLE member_access_log ADD COLUMN IF NOT EXISTS actor_id          VARCHAR(64);
ALTER TABLE member_access_log ADD COLUMN IF NOT EXISTS mapping_id        UUID;
ALTER TABLE member_access_log ADD COLUMN IF NOT EXISTS hardware_group_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_member_access_log_trace
    ON member_access_log (trace_id)
    WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_member_access_log_actor
    ON member_access_log (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_member_access_log_mapping
    ON member_access_log (mapping_id)
    WHERE mapping_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. error_queue — add trace + actor columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE error_queue ADD COLUMN IF NOT EXISTS trace_id   VARCHAR(36);
ALTER TABLE error_queue ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE error_queue ADD COLUMN IF NOT EXISTS actor_id   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_error_queue_trace
    ON error_queue (trace_id)
    WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_queue_actor
    ON error_queue (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. adapter_admin_log — add trace + actor columns
-- ────────────────────────────────────────────────────────────────────────────
-- Note: adapter_admin_log already has configured_by (legacy actor field). We add
-- actor_type + actor_id to align with the new universal context, while keeping
-- configured_by for backward compat. The v_trace_timeline view COALESCEs them.
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS trace_id   VARCHAR(36);
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS actor_id   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_adapter_admin_log_trace
    ON adapter_admin_log (trace_id)
    WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_adapter_admin_log_actor
    ON adapter_admin_log (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. config_alert_log — add trace + actor columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE config_alert_log ADD COLUMN IF NOT EXISTS trace_id   VARCHAR(36);
ALTER TABLE config_alert_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20);
ALTER TABLE config_alert_log ADD COLUMN IF NOT EXISTS actor_id   VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_config_alert_log_trace
    ON config_alert_log (trace_id)
    WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_config_alert_log_actor
    ON config_alert_log (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. activity_event — new table for actor-action audit records
-- ────────────────────────────────────────────────────────────────────────────
-- Captures user actions that don't fit the existing log tables: operator UI
-- clicks, member portal actions, owner admin edits, system-generated events.
-- Fire-and-forget INSERT from admin/middleware/activity.js (DR-037).
CREATE TABLE IF NOT EXISTS activity_event (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trace_id      VARCHAR(36) NOT NULL,
    ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    client_id     UUID,
    actor_type    VARCHAR(20) NOT NULL,    -- owner | operator | member | system | webhook
    actor_id      VARCHAR(64) NOT NULL,
    action        VARCHAR(80) NOT NULL,    -- from core/EVENT_REGISTRY.md (DR-038)
    target_type   VARCHAR(40),             -- 'plan_mapping', 'member', 'location', etc.
    target_id     VARCHAR(64),
    result        VARCHAR(20) NOT NULL DEFAULT 'success',  -- success | failure | rejected
    diff          JSONB,                   -- before/after for mutations (redacted, DR-039)
    request_meta  JSONB                    -- IP, user-agent, route, method (audit-only PII per DR-039)
);

CREATE INDEX IF NOT EXISTS idx_activity_event_trace
    ON activity_event (trace_id);

CREATE INDEX IF NOT EXISTS idx_activity_event_actor
    ON activity_event (actor_type, actor_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_activity_event_target
    ON activity_event (target_type, target_id, ts DESC)
    WHERE target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_event_client
    ON activity_event (client_id, ts DESC)
    WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_event_action
    ON activity_event (action, ts DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. v_trace_timeline — unified cross-surface view
-- ────────────────────────────────────────────────────────────────────────────
-- One query (`SELECT * FROM v_trace_timeline WHERE trace_id = X`) returns the
-- full ordered story of any event across every observation surface.
--
-- All seven sources unioned with consistent column shape:
--   trace_id, ts, source, actor_type, actor_id, event, target_type, target_id, result, detail, client_id
--
-- Only rows with trace_id IS NOT NULL appear (pre-migration rows stay invisible
-- in the timeline, which is correct).
CREATE OR REPLACE VIEW v_trace_timeline AS

-- activity_event — actor-action audit records
SELECT
    trace_id,
    ts,
    'activity'::text                     AS source,
    actor_type,
    actor_id,
    action                               AS event,
    target_type,
    target_id,
    result,
    diff::jsonb                          AS detail,
    client_id
FROM activity_event
WHERE trace_id IS NOT NULL

UNION ALL

-- webhook_log — inbound webhook records
SELECT
    trace_id,
    received_at                          AS ts,
    'webhook'::text                      AS source,
    actor_type,
    actor_id,
    event_type                           AS event,
    'webhook'::text                      AS target_type,
    event_id                             AS target_id,
    hmac_status                          AS result,
    normalized_payload::jsonb            AS detail,
    client_id
FROM webhook_log
WHERE trace_id IS NOT NULL

UNION ALL

-- diagnostic_log — warn/error/critical persisted log entries
SELECT
    trace_id,
    created_at                           AS ts,
    'diagnostic'::text                   AS source,
    actor_type,
    actor_id,
    error_code                           AS event,
    service                              AS target_type,
    NULL::varchar                        AS target_id,
    level                                AS result,
    context::jsonb                       AS detail,
    client_id
FROM diagnostic_log
WHERE trace_id IS NOT NULL

UNION ALL

-- member_access_log — member lifecycle events
SELECT
    trace_id,
    created_at                           AS ts,
    'member_access'::text                AS source,
    actor_type,
    actor_id,
    event_type                           AS event,
    'member'::text                       AS target_type,
    member_id::text                      AS target_id,
    COALESCE(error_code, 'success')      AS result,
    jsonb_build_object(
        'mapping_id',        mapping_id,
        'hardware_group_id', hardware_group_id,
        'credential_type',   credential_type,
        'credential_value',  credential_value
    )                                    AS detail,
    client_id
FROM member_access_log
WHERE trace_id IS NOT NULL

UNION ALL

-- error_queue — dead-letter records
SELECT
    trace_id,
    created_at                           AS ts,
    'error_queue'::text                  AS source,
    actor_type,
    actor_id,
    event_type                           AS event,
    'error'::text                        AS target_type,
    id::text                             AS target_id,
    status                               AS result,
    jsonb_build_object(
        'error_reason', error_reason,
        'error_code',   error_code,
        'plan_name',    plan_name,
        'door_name',    door_name,
        'member_id',    member_id,
        'http_status',  http_status
    )                                    AS detail,
    client_id
FROM error_queue
WHERE trace_id IS NOT NULL

UNION ALL

-- adapter_admin_log — operator admin audit trail (configured_by is legacy actor field)
SELECT
    trace_id,
    COALESCE(configured_at, created_at)  AS ts,
    'admin_audit'::text                  AS source,
    actor_type,
    COALESCE(actor_id, configured_by)    AS actor_id,
    COALESCE(admin_action, event_type)   AS event,
    target_entity                        AS target_type,
    target_id::text                      AS target_id,
    result,
    details::jsonb                       AS detail,
    client_id
FROM adapter_admin_log
WHERE trace_id IS NOT NULL

UNION ALL

-- config_alert_log — operator-facing config issues + reconciliation flags
SELECT
    trace_id,
    created_at                           AS ts,
    'config_alert'::text                 AS source,
    actor_type,
    actor_id,
    alert_type                           AS event,
    'config'::text                       AS target_type,
    plan_mapping_id::text                AS target_id,
    CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END  AS result,
    jsonb_build_object(
        'hardware_ref',          hardware_ref,
        'affected_member_count', affected_member_count,
        'last_seen_at',          last_seen_at
    )                                    AS detail,
    client_id
FROM config_alert_log
WHERE trace_id IS NOT NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION VERIFICATION (run manually after the BEGIN/COMMIT block above)
-- ════════════════════════════════════════════════════════════════════════════
-- Step A — confirm view compiles + returns rows (or 0 rows with no error):
--    SELECT * FROM v_trace_timeline LIMIT 5;
--
-- Step B — confirm new columns exist:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'member_access_log'
--    ORDER BY ordinal_position;
--    (expect: ..., trace_id, actor_type, actor_id, mapping_id, hardware_group_id)
--
-- Step C — confirm activity_event table + indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename = 'activity_event';
--    (expect: 5 idx_activity_event_* indexes)
--
-- ════════════════════════════════════════════════════════════════════════════
