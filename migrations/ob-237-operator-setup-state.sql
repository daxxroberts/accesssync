-- OB-237 Phase A — operator_setup_state table
-- Tracks per-(operator × snippet) install state so AccessSync KNOWS what's
-- installed on the Wix side. Powers the Setup Hub status badges + Dashboard pill.

BEGIN;

CREATE TABLE IF NOT EXISTS operator_setup_state (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  snippet_id             TEXT NOT NULL,
  install_state          TEXT NOT NULL DEFAULT 'not_installed'
                           CHECK (install_state IN (
                             'not_installed',
                             'installed_unverified',
                             'verified',
                             'stale',
                             'broken'
                           )),
  version_installed      TEXT,
  last_telemetry_at      TIMESTAMPTZ,
  last_telemetry_version TEXT,
  last_verified_at       TIMESTAMPTZ,
  last_test_at           TIMESTAMPTZ,
  last_test_result       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operator_setup_state_unique UNIQUE (client_id, snippet_id)
);

CREATE INDEX IF NOT EXISTS operator_setup_state_client
  ON operator_setup_state (client_id);

CREATE INDEX IF NOT EXISTS operator_setup_state_stale
  ON operator_setup_state (install_state, last_telemetry_at DESC);

COMMENT ON TABLE operator_setup_state IS
  'OB-237 — per-(client × snippet_id) install state. Updated by webhook x-accesssync-snippet-version header (Phase C) and iframe heartbeat pings. Drives Setup Hub badges + Dashboard pill.';

COMMENT ON COLUMN operator_setup_state.install_state IS
  'not_installed: never detected. installed_unverified: copied via Setup Hub but no telemetry yet. verified: telemetry within stale_after_days window. stale: telemetry older than registry stale_after_days. broken: Test Connection failed or HMAC mismatch.';

COMMENT ON COLUMN operator_setup_state.version_installed IS
  'Last known version installed (from webhook header or Setup Hub copy action). Compared against snippet_registry.current_version to detect stale.';

COMMIT;
