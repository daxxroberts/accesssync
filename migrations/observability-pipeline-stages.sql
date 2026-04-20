-- observability-pipeline-stages.sql
-- Adds index on member_access_log(member_id, created_at DESC) for efficient
-- per-member lifecycle queries used by the diagnose/timeline endpoints.
-- Safe to run while code is deployed — index-only, no schema changes.

CREATE INDEX IF NOT EXISTS idx_member_access_log_member_created
    ON member_access_log (member_id, created_at DESC);
