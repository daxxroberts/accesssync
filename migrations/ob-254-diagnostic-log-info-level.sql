-- OB-254: allow info-level rows in diagnostic_log.
--
-- The CHECK only permitted warn/error/critical, so any info-level event carrying a
-- persist:true override in EVENT_REGISTRY.json failed its INSERT and emitted a
-- logger.diagnostic_log_write_failed error line instead of persisting. That silently
-- hid the DR-052 email.member.* events and the DR-053 email.operator.sent /
-- health.alert_suppressed events from the trace timeline.
--
-- Additive widening only — no existing row can violate the new constraint.
-- Applied to Supabase gklgwyrnkedebyulrclv 2026-07-25.

ALTER TABLE diagnostic_log DROP CONSTRAINT IF EXISTS diagnostic_log_level_check;

ALTER TABLE diagnostic_log ADD CONSTRAINT diagnostic_log_level_check
  CHECK (level IN ('info', 'warn', 'error', 'critical'));
