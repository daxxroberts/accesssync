-- migrations/diagnostic-log-level-created.sql
-- L9 (SAGE decision log 2026-10-05): the owner panel's 24h checks (system-health.js: errors / warnings /
-- DB_SLOW_QUERY in the last 24h, across every client) filter diagnostic_log by level and created_at. No existing
-- index covers that: idx_diagnostic_log_client_created is per client and only for unresolved rows.
-- Not urgent: 13,826 rows / 11 MB on 2026-10-08. Growth is ~350k rows a year at one gym, more per added gym.
-- NOT APPLIED. Production DDL is a RULE-19 Tier 4 action: Daxx (or a session he authorises) runs it.
-- CONCURRENTLY: no table lock, safe on the live DB. Must run outside a transaction block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_diagnostic_log_level_created
  ON diagnostic_log (level, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_diagnostic_log_code_created
  ON diagnostic_log (error_code, created_at DESC);
