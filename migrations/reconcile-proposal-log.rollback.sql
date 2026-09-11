-- ROLLBACK for reconcile-proposal-log.sql: drops reconciliation_proposal.
--
-- Its index (idx_recon_proposal_client_created) and foreign keys go with it.
--
-- WARNING: this throws away the whole proposal log, which is the evidence the
-- Builder reviews before any client's automatic removals are switched on. Export
-- it first if it matters:
--   SELECT * FROM reconciliation_proposal ORDER BY created_at;
--
-- Order: either. The sweep writes the log inside try/catch, so with the table gone
-- a deployed sweep logs a warning once and carries on. Nobody's access changes.

DROP TABLE IF EXISTS reconciliation_proposal;
