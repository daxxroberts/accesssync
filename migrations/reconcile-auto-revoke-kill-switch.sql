-- Reconciliation safety pass (2026-09-10): per-client automatic-removal mode.
--
-- Why: the reconciliation sweep's automatic removals have to be stoppable per
-- client, and switchable into a "show me what you would remove" mode, while grants
-- keep flowing. A bulk import of members with no Wix order is coming, and the
-- removal path is being rebuilt behind a double Wix read, strike clocks and a
-- mass-revoke cap. None of that should be armed until the Builder has reviewed
-- what it proposes.
--
-- clients.auto_revoke_mode is that switch. Three values:
--   'off'      the sweep holds every automatic removal.
--   'dry_run'  the sweep works out and records what it would remove
--              (reconciliation_proposal) but enqueues nothing.
--   'on'       removals that pass every safety gate may be enqueued. This is
--              armed in Phase 3b. Phase 1 code is observation-only in every mode.
-- Grants are never gated by it. Real-time Wix webhook cancellations are NOT gated
-- by it either.
--
-- This file replaces an earlier draft of itself that added a BOOLEAN column,
-- clients.auto_revoke_enabled. That draft was never applied. Before applying,
-- confirm it really is absent:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'clients'
--      AND column_name IN ('auto_revoke_enabled', 'auto_revoke_mode');
-- Expect zero rows. If auto_revoke_enabled shows up, stop and ask the Builder:
-- this file does not touch it.
--
-- DEFAULT 'dry_run' is deliberate. Every existing client lands in dry-run, so the
-- sweep records removal proposals for review and removes nobody. 'on' is never the
-- default: switching a client on is an explicit, per-client Builder decision.
-- ADD COLUMN ... NOT NULL DEFAULT 'dry_run' gives every existing row 'dry_run' as
-- part of the ALTER itself (metadata-only on Postgres 11+, no table rewrite), so no
-- backfill statement is needed, and none is included. The CHECK is validated
-- against the existing clients rows during the ALTER; every one holds the default,
-- so it passes. The ALTER briefly takes an exclusive lock on clients, a table of a
-- handful of rows.
--
-- The application reads the column fail-closed (core/revoke-policy.js
-- normalizeMode): anything other than exactly 'dry_run' or 'on', including a NULL,
-- a missing column or a failed read, is treated as 'off'.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS skips the whole column definition, CHECK
-- included, when the column already exists, and COMMENT ON just overwrites.
-- Additive and reversible: one new column, no existing data changed. Rollback is
-- reconcile-auto-revoke-kill-switch.rollback.sql (read its header first).
--
-- ORDER: apply this BEFORE deploying the code that reads the column. If the code
-- ships first it degrades safely rather than failing: the read fails, the mode is
-- treated as 'off', the sweep holds removals, and grants and audit logging carry
-- on. (In Phase 1 the sweep's removals are observation-only anyway.)
--
-- Applied to Supabase gklgwyrnkedebyulrclv 2026-09-11.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS auto_revoke_mode VARCHAR(16) NOT NULL DEFAULT 'dry_run'
    CONSTRAINT clients_auto_revoke_mode_check
    CHECK (auto_revoke_mode IN ('off', 'dry_run', 'on'));

COMMENT ON COLUMN clients.auto_revoke_mode IS
  'Per-client mode for the reconciliation sweep''s automatic removals: off holds every '
  'automatic removal; dry_run records what the sweep would remove (reconciliation_proposal) '
  'and enqueues nothing; on lets removals that pass every safety gate be enqueued. Grants '
  'continue unaffected in every mode. Real-time Wix webhook cancellations are NOT affected. '
  'The application reads it fail-closed: anything other than dry_run or on is treated as off. '
  'Default dry_run: no client removes anyone automatically until switched on explicitly.';
