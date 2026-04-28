-- dr-041.sql
-- DR-041: trace_context lookup table — enriched trace header for unified log search
-- DR-037 (Observability Architecture) — extends the logging foundation
--
-- Problem: trace_id floats through 7 log tables with no home. The log viewer has no
-- single place to answer "who/what/where was this trace?" for client name, member name,
-- hardware platform, source platform, or door/plan context.
--
-- Solution: one row per trace, written at mint time by registerTrace(). Every log
-- table already carries trace_id. The log viewer JOINs trace_context to resolve all
-- human-readable context in one pass — no per-row lookups required.
--
-- Additive, idempotent. No existing tables modified.
-- Safe to run against live Railway DB.
--
-- Applied: 2026-04-27

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- trace_context — one row per trace ID, written at entry point
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trace_context (
  trace_id            VARCHAR(36)  PRIMARY KEY,
  started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Client resolution
  client_id           UUID         REFERENCES clients(id) ON DELETE SET NULL,
  client_name         VARCHAR(255),

  -- Member resolution (resolved from member_identity at mint time)
  member_id           UUID         REFERENCES member_identity(id) ON DELETE SET NULL,
  member_name         VARCHAR(255),
  member_email        VARCHAR(255),
  platform_member_id  VARCHAR(255),

  -- Source platform
  source_platform     VARCHAR(50),   -- 'wix' | future platforms

  -- Hardware platform
  hardware_platform   VARCHAR(50),   -- 'kisi' | 'seam' | future
  hardware_user_id    VARCHAR(64),   -- e.g. '99561846' (Kisi user ID)

  -- Plan / door context (resolved at mint when available)
  plan_name           VARCHAR(255),
  door_name           VARCHAR(255),
  mapping_id          UUID,

  -- Actor who originated the trace
  actor_type          VARCHAR(20),   -- 'owner' | 'operator' | 'member' | 'system' | 'webhook'
  actor_id            VARCHAR(64),

  -- What entry point minted the trace
  entry_point         VARCHAR(50)    -- 'webhook' | 'operator_ui' | 'admin_ui' | 'cron' | 'queue' | 'api'
);

-- Indexes for every filter dimension the log viewer needs
CREATE INDEX IF NOT EXISTS idx_trace_context_client
    ON trace_context (client_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_trace_context_member
    ON trace_context (member_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_trace_context_hardware
    ON trace_context (hardware_platform, hardware_user_id)
    WHERE hardware_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_context_source
    ON trace_context (source_platform)
    WHERE source_platform IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_context_actor
    ON trace_context (actor_type, actor_id)
    WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trace_context_started
    ON trace_context (started_at DESC);

-- Full-text search index across all human-readable name columns
CREATE INDEX IF NOT EXISTS idx_trace_context_fts
    ON trace_context
    USING gin (
      to_tsvector('english',
        coalesce(client_name, '') || ' ' ||
        coalesce(member_name, '') || ' ' ||
        coalesce(member_email, '') || ' ' ||
        coalesce(platform_member_id, '') || ' ' ||
        coalesce(hardware_user_id, '') || ' ' ||
        coalesce(plan_name, '') || ' ' ||
        coalesce(door_name, '')
      )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- v_trace_timeline — rebuild to LEFT JOIN trace_context for enriched rows
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaces the original view (CREATE OR REPLACE is safe).
-- Adds tc.client_name, tc.member_name, tc.member_email, tc.source_platform,
-- tc.hardware_platform, tc.hardware_user_id, tc.plan_name, tc.door_name,
-- tc.entry_point to every row so the UI never needs a second query.

CREATE OR REPLACE VIEW v_trace_timeline AS

SELECT
  ae.trace_id,
  ae.ts,
  'activity'::text           AS source,
  ae.actor_type,
  ae.actor_id,
  ae.action                  AS event,
  ae.target_type,
  ae.target_id,
  ae.result,
  ae.diff::jsonb             AS detail,
  ae.client_id,
  -- enrichment from trace_context
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM activity_event ae
LEFT JOIN trace_context tc ON tc.trace_id = ae.trace_id
WHERE ae.trace_id IS NOT NULL

UNION ALL

SELECT
  wl.trace_id,
  wl.received_at             AS ts,
  'webhook'::text            AS source,
  wl.actor_type,
  wl.actor_id,
  wl.event_type              AS event,
  'webhook'::text            AS target_type,
  wl.event_id                AS target_id,
  wl.hmac_status             AS result,
  wl.normalized_payload::jsonb AS detail,
  wl.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM webhook_log wl
LEFT JOIN trace_context tc ON tc.trace_id = wl.trace_id
WHERE wl.trace_id IS NOT NULL

UNION ALL

SELECT
  dl.trace_id,
  dl.created_at              AS ts,
  'diagnostic'::text         AS source,
  dl.actor_type,
  dl.actor_id,
  dl.error_code              AS event,
  dl.service                 AS target_type,
  NULL                       AS target_id,
  dl.level                   AS result,
  dl.context::jsonb          AS detail,
  dl.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM diagnostic_log dl
LEFT JOIN trace_context tc ON tc.trace_id = dl.trace_id
WHERE dl.trace_id IS NOT NULL

UNION ALL

SELECT
  mal.trace_id,
  mal.created_at             AS ts,
  'member_access'::text      AS source,
  mal.actor_type,
  mal.actor_id,
  mal.event_type             AS event,
  'member'::text             AS target_type,
  mal.member_id::text        AS target_id,
  COALESCE(mal.error_code, 'success') AS result,
  jsonb_build_object(
    'mapping_id',        mal.mapping_id,
    'hardware_group_id', mal.hardware_group_id
  )                          AS detail,
  mal.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM member_access_log mal
LEFT JOIN trace_context tc ON tc.trace_id = mal.trace_id
WHERE mal.trace_id IS NOT NULL

UNION ALL

SELECT
  eq.trace_id,
  eq.created_at              AS ts,
  'error_queue'::text        AS source,
  eq.actor_type,
  eq.actor_id,
  eq.event_type              AS event,
  'error'::text              AS target_type,
  eq.id::text                AS target_id,
  eq.status                  AS result,
  jsonb_build_object(
    'error_reason', eq.error_reason,
    'error_code',   eq.error_code,
    'plan_name',    eq.plan_name,
    'door_name',    eq.door_name
  )                          AS detail,
  eq.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM error_queue eq
LEFT JOIN trace_context tc ON tc.trace_id = eq.trace_id
WHERE eq.trace_id IS NOT NULL

UNION ALL

SELECT
  aal.trace_id,
  COALESCE(aal.configured_at, aal.created_at) AS ts,
  'admin_audit'::text        AS source,
  aal.actor_type,
  COALESCE(aal.actor_id, aal.configured_by) AS actor_id,
  COALESCE(aal.admin_action, aal.event_type) AS event,
  aal.target_entity          AS target_type,
  aal.target_id::text        AS target_id,
  aal.result,
  aal.details::jsonb         AS detail,
  aal.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM adapter_admin_log aal
LEFT JOIN trace_context tc ON tc.trace_id = aal.trace_id
WHERE aal.trace_id IS NOT NULL

UNION ALL

SELECT
  cal.trace_id,
  cal.created_at             AS ts,
  'config_alert'::text       AS source,
  cal.actor_type,
  cal.actor_id,
  cal.alert_type             AS event,
  'config'::text             AS target_type,
  cal.plan_mapping_id::text  AS target_id,
  CASE WHEN cal.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS result,
  jsonb_build_object(
    'hardware_ref',          cal.hardware_ref,
    'affected_member_count', cal.affected_member_count
  )                          AS detail,
  cal.client_id,
  tc.client_name,
  tc.member_name,
  tc.member_email,
  tc.source_platform,
  tc.hardware_platform,
  tc.hardware_user_id,
  tc.plan_name,
  tc.door_name,
  tc.entry_point
FROM config_alert_log cal
LEFT JOIN trace_context tc ON tc.trace_id = cal.trace_id
WHERE cal.trace_id IS NOT NULL

ORDER BY ts DESC;

COMMIT;
