-- DR-052: Branded member-facing emails — per-client branding + send log.
--
-- clients branding columns power the "Set up logo" screen: logo + primary/secondary color
-- (everything else renders on white), with clients.notification_email reused as the
-- member-facing Reply-To / footer admin contact (no new column). member_emails_enabled is
-- the ship-dark toggle — Phase 1 deploys with every client OFF; enablement is explicit
-- and per-client after live verification.
--
-- member_email_log is the idempotency + audit spine for every member-facing send:
--   * UNIQUE (client_id, email_type, dedup_key) + INSERT ... ON CONFLICT DO NOTHING RETURNING
--     = atomic once-only sends (the clients.first_grant_sent pattern, generalized).
--   * recipient is PII — purged alongside member_master PII in finalizeRevoke (DR-001-A).
--   * resend_id + delivery_status are the Phase-2 delivery-webhook join points
--     (supersedes OB-250's member_master.email_delivery_status sketch — one member can
--     receive many emails; status belongs on the send, not the person).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS email_logo_url        TEXT,
  ADD COLUMN IF NOT EXISTS email_primary_color   VARCHAR(7),
  ADD COLUMN IF NOT EXISTS email_secondary_color VARCHAR(7),
  ADD COLUMN IF NOT EXISTS member_emails_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS member_email_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_master_id uuid REFERENCES member_master(id) ON DELETE SET NULL,
  email_type       varchar(40) NOT NULL,
  dedup_key        text NOT NULL,
  recipient        text,
  resend_id        text,
  delivery_status  varchar(20) NOT NULL DEFAULT 'sent',
  trace_id         text,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT member_email_log_dedup UNIQUE (client_id, email_type, dedup_key)
);

CREATE INDEX IF NOT EXISTS member_email_log_member_idx ON member_email_log (member_master_id);
CREATE INDEX IF NOT EXISTS member_email_log_client_created_idx ON member_email_log (client_id, created_at DESC);

COMMENT ON TABLE member_email_log IS
  'DR-052: one row per member-facing email send attempt. UNIQUE dedup makes sends once-only; recipient purged with member PII (DR-001-A); resend_id/delivery_status filled by the Phase-2 Resend delivery webhook.';
COMMENT ON COLUMN clients.member_emails_enabled IS
  'DR-052 ship-dark toggle: member-facing branded emails send only when true. Default false; enable per client after live verification.';
