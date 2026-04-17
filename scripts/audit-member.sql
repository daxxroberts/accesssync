-- audit-member.sql
-- Trace a single AccessSync member across every lifecycle table.
-- Shows webhook arrival, identity creation, Kisi user linkage, access state,
-- role assignments, audit log, and any errors — ordered chronologically so the
-- operator can see exactly how far the pipeline progressed for this member.
--
-- Usage:
--   psql "$DATABASE_PUBLIC_URL" -v pmid=7af07f2c-6c9b-4180-9c79-6697e1d673a9 -f scripts/audit-member.sql
--
-- To change target member, pass a different -v pmid=<uuid> at invocation.

\if :{?pmid}
\else
  \set pmid '7af07f2c-6c9b-4180-9c79-6697e1d673a9'
\endif

\echo '=== AUDIT TARGET ==='
\echo pmid = :pmid
\echo

WITH m AS (
  SELECT id, client_id, platform_member_id, source_platform,
         hardware_user_id, hardware_platform, created_at
  FROM member_identity
  WHERE platform_member_id = :'pmid'
)
SELECT 'member_identity' AS tbl, created_at AS ts, row_to_json(m.*)::text AS data FROM m
UNION ALL
SELECT 'member_access_state', updated_at, row_to_json(s.*)::text
  FROM member_access_state s
  WHERE member_id IN (SELECT id FROM m)
UNION ALL
SELECT 'member_role_assignments', created_at, row_to_json(r.*)::text
  FROM member_role_assignments r
  WHERE member_id IN (SELECT id FROM m)
UNION ALL
SELECT 'member_access_log', created_at, row_to_json(l.*)::text
  FROM member_access_log l
  WHERE member_id IN (SELECT id FROM m)
UNION ALL
SELECT 'error_queue', created_at, row_to_json(e.*)::text
  FROM error_queue e
  WHERE member_id IN (SELECT id FROM m)
UNION ALL
SELECT 'adapter_admin_log', created_at, row_to_json(a.*)::text
  FROM adapter_admin_log a
  WHERE platform_member_id = :'pmid'
UNION ALL
SELECT 'webhook_log', received_at, row_to_json(w.*)::text
  FROM webhook_log w
  WHERE raw_payload::text ILIKE '%' || :'pmid' || '%'
UNION ALL
SELECT 'diagnostic_log', created_at, row_to_json(d.*)::text
  FROM diagnostic_log d
  WHERE context->>'memberId'         = :'pmid'
     OR context->>'platformMemberId' = :'pmid'
     OR context::text ILIKE '%' || :'pmid' || '%'
ORDER BY ts ASC NULLS LAST;

-- member_access_sources may not exist yet (OB-46 pending). Probe safely.
DO $$
DECLARE
  tgt text := current_setting('audit.pmid', true);
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'member_access_sources'
  ) THEN
    RAISE NOTICE 'member_access_sources: exists — scan separately with:';
    RAISE NOTICE '  SELECT * FROM member_access_sources WHERE member_id IN (SELECT id FROM member_identity WHERE platform_member_id = ''%'');', tgt;
  ELSE
    RAISE NOTICE 'member_access_sources: does not exist (OB-46 pending)';
  END IF;
END $$;
