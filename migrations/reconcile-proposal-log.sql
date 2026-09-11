-- Reconciliation safety pass (2026-09-10): reconciliation_proposal, the sweep's
-- proposal log.
--
-- Why: before the sweep is ever allowed to remove anyone automatically, the
-- Builder has to be able to read what it WOULD have done. Every proposal the sweep
-- makes (a removal it would queue, a repair it would make) is written here with the
-- decision taken on it and the reason. In Phase 1 every decision is 'held': the
-- sweep is observation-only. In Phase 3b a client runs in dry_run for at least 48h
-- and the Builder reviews this log before switching it on.
--
-- One row per proposal per sweep. Columns:
--   run_id             the reconciliation_run row of the sweep that made it
--                      (NULL when no run row exists).
--   client_id          the client (operator account).
--   platform_member_id the member the proposal is about.
--   source_plan_id     the plan it concerns, when it is plan-scoped.
--   hardware_group_id  the Kisi group (door) it concerns, when door-scoped.
--   kind               what kind of proposal, e.g. removal_pending / repair_pending.
--   source             which sweep path raised it (core/revoke-policy.js REVOKE_SOURCE).
--   data_source        which vendor read it rests on: wix_orders / wix_bookings /
--                      kisi / db.
--   classification     the Wix order class seen (PAYING / PENDING / DECLINED /
--                      ENDED / UNKNOWN), when relevant.
--   decision           what the sweep did with it. Phase 1: always 'held'.
--   hold_reason        why it was held (the policy reason, e.g. observation_only).
--   evidence           free-form JSON the sweep attaches (reads, strike clock, ...).
-- No CHECK constraints on the text columns on purpose: this is a log, and a
-- rejected INSERT would lose the evidence rather than protect anything.
--
-- The sweep writes it with one batched INSERT per sweep inside try/catch. It never
-- reads it to make a decision.
--
-- run_id matches reconciliation_run.id (UUID, see migrations/reconciliation-run.sql
-- and supabase-bootstrap.sql). Deleting a run, or a client, deletes its proposals
-- (ON DELETE CASCADE). id uses gen_random_uuid(), the same default
-- reconciliation_run.id already relies on.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS, and COMMENT ON just
-- overwrites. Additive and reversible: one new, empty table and its index. No
-- existing table or row is changed. Rollback is reconcile-proposal-log.rollback.sql.
--
-- ORDER: either. If the code ships first, the INSERT fails, the sweep logs a warning
-- once and carries on. Nothing else depends on this table.
--
-- Applied to Supabase gklgwyrnkedebyulrclv 2026-09-11.

CREATE TABLE IF NOT EXISTS reconciliation_proposal (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NULL REFERENCES reconciliation_run(id) ON DELETE CASCADE,
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform_member_id VARCHAR,
  source_plan_id     VARCHAR,
  hardware_group_id  VARCHAR,
  kind               VARCHAR(32) NOT NULL,
  source             VARCHAR(32),
  data_source        VARCHAR(32),
  classification     VARCHAR(16),
  decision           VARCHAR(16) NOT NULL,
  hold_reason        VARCHAR(48),
  evidence           JSONB,
  created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_proposal_client_created
  ON reconciliation_proposal (client_id, created_at DESC);

COMMENT ON TABLE reconciliation_proposal IS
  'Proposal log for the reconciliation sweep: one row per removal or repair the sweep '
  'proposed, with the decision taken (Phase 1: always held) and the reason. Written by '
  'the sweep for Builder review before automatic removal is switched on. Log only: '
  'the sweep never reads it to decide anything.';
