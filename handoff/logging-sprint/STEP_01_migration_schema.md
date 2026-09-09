# Step 1 — Migration: Schema Additions + activity_event + v_trace_timeline

**Owner:** ORION (drafts) · FELIX (validates)
**Estimated time:** 1 hour
**Blocks:** Steps 2-12
**Prerequisite:** Phase 0 — DR-036 approved by SAGE

---

## What this step delivers

A single Railway-runnable migration file that:
1. Adds `trace_id`, `actor_type`, `actor_id` columns to all six existing log tables (additive, NULL-defaulted, non-breaking)
2. Creates the `activity_event` table for actor-action records
3. Creates indexes per ORION's design
4. Creates the `v_trace_timeline` view that unions all log tables

---

## Output file

`migrations/observability-foundation.sql`

---

## Spec

### Existing log tables — add columns

Six tables get the same three additive columns. Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so the migration is idempotent and forward-compatible with the existing `trace_id` columns on `webhook_log` and `diagnostic_log` (already added by `observability-trace-id.sql`).

| Table | Columns to add |
|---|---|
| `diagnostic_log` | `actor_type`, `actor_id` (trace_id already exists) |
| `webhook_log` | `actor_type`, `actor_id` (trace_id already exists) |
| `member_access_log` | `trace_id`, `actor_type`, `actor_id`, `mapping_id`, `hardware_group_id` |
| `error_queue` | `trace_id`, `actor_type`, `actor_id` |
| `adapter_admin_log` | `trace_id`, `actor_type`, `actor_id` |
| `config_alert_log` | `trace_id`, `actor_type`, `actor_id` |

> **NOTE on `member_access_log`:** ORION adds `mapping_id` + `hardware_group_id` here so the lifecycle audit log finally answers "which mapping/door did this provision/revoke affect?" This is part of the unified-timeline goal — without these columns, member events can't be correlated with mapping events. AXIOM gate: confirm DR-036 covers this enrichment, OR add a parallel DR.

### Column specifications

```sql
trace_id    VARCHAR(36)  -- UUID v4 string format
actor_type  VARCHAR(20)  -- 'owner' | 'operator' | 'member' | 'system' | 'webhook'
actor_id    VARCHAR(64)  -- user UUID, member UUID, or 'system'/'webhook'
mapping_id  UUID         -- (member_access_log only) FK-shape, no constraint
hardware_group_id VARCHAR(64) -- (member_access_log only)
```

All NULL-defaulted. No NOT NULL constraints. No backfill of historical rows.

### Indexes — partial, only on rows with values

```sql
CREATE INDEX IF NOT EXISTS idx_<table>_trace_id ON <table>(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_<table>_actor    ON <table>(actor_type, actor_id) WHERE actor_id IS NOT NULL;
```

Per existing pattern in `migrations/observability-trace-id.sql`. Apply to all six tables.

### New table — activity_event

```sql
CREATE TABLE IF NOT EXISTS activity_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id     VARCHAR(36) NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_id    UUID,
  actor_type   VARCHAR(20) NOT NULL,
  actor_id     VARCHAR(64) NOT NULL,
  action       VARCHAR(80) NOT NULL,
  target_type  VARCHAR(40),
  target_id    VARCHAR(64),
  result       VARCHAR(20) NOT NULL DEFAULT 'success',
  diff         JSONB,
  request_meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_activity_event_trace  ON activity_event(trace_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_actor  ON activity_event(actor_type, actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_event_target ON activity_event(target_type, target_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_event_client ON activity_event(client_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_event_action ON activity_event(action, ts DESC);
```

### New view — v_trace_timeline

```sql
CREATE OR REPLACE VIEW v_trace_timeline AS
SELECT
  trace_id, ts, 'activity'::text AS source,
  actor_type, actor_id, action AS event,
  target_type, target_id, result, diff::jsonb AS detail, client_id
FROM activity_event
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, received_at AS ts, 'webhook'::text AS source,
  actor_type, actor_id, event_type AS event,
  'webhook'::text AS target_type, event_id AS target_id,
  hmac_status AS result, normalized_payload::jsonb AS detail, client_id
FROM webhook_log
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, created_at AS ts, 'diagnostic'::text AS source,
  actor_type, actor_id, error_code AS event,
  service AS target_type, NULL AS target_id,
  level AS result, context::jsonb AS detail, client_id
FROM diagnostic_log
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, created_at AS ts, 'member_access'::text AS source,
  actor_type, actor_id, event_type AS event,
  'member'::text AS target_type, member_id::text AS target_id,
  COALESCE(error_code, 'success') AS result,
  jsonb_build_object('mapping_id', mapping_id, 'hardware_group_id', hardware_group_id) AS detail,
  client_id
FROM member_access_log
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, created_at AS ts, 'error_queue'::text AS source,
  actor_type, actor_id, event_type AS event,
  'error'::text AS target_type, id::text AS target_id,
  status AS result,
  jsonb_build_object('error_reason', error_reason, 'error_code', error_code, 'plan_name', plan_name) AS detail,
  client_id
FROM error_queue
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, configured_at AS ts, 'admin_audit'::text AS source,
  actor_type, COALESCE(actor_id, configured_by) AS actor_id, COALESCE(admin_action, event_type) AS event,
  target_entity AS target_type, target_id::text AS target_id,
  result, details::jsonb AS detail, client_id
FROM adapter_admin_log
WHERE trace_id IS NOT NULL

UNION ALL

SELECT
  trace_id, created_at AS ts, 'config_alert'::text AS source,
  actor_type, actor_id, alert_type AS event,
  'config'::text AS target_type, plan_mapping_id::text AS target_id,
  CASE WHEN resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS result,
  jsonb_build_object('hardware_ref', hardware_ref, 'affected_member_count', affected_member_count) AS detail,
  client_id
FROM config_alert_log
WHERE trace_id IS NOT NULL

ORDER BY ts;
```

> **ORION verification step:** Run `SELECT * FROM v_trace_timeline LIMIT 1` against Railway DB after migration. View must compile with no errors. If any column type mismatch — fix in this migration before commit.

---

## FELIX validation checklist

Before this migration is committed:

- [ ] All six `ALTER TABLE` statements use `IF NOT EXISTS` on column adds
- [ ] All index `CREATE INDEX IF NOT EXISTS` clauses include the partial `WHERE` predicate
- [ ] `activity_event` table has all five indexes
- [ ] `v_trace_timeline` view compiles cleanly (run `psql … -f migration.sql` against a clone or Railway DB and verify)
- [ ] `SELECT * FROM v_trace_timeline LIMIT 1` returns rows OR returns 0 rows with no error (not an error like "column type mismatch in UNION")
- [ ] No DROP statements anywhere in this file (additive only)
- [ ] File header comment block: filename, date, what it does, rollback note (NULL-defaulted columns can stay; `activity_event` table can be dropped if rolling back)

---

## Run procedure

```bash
# From repo root, against Railway DATABASE_PUBLIC_URL
node -e "
const { Pool } = require('pg');
const fs = require('fs');
const sql = fs.readFileSync('migrations/observability-foundation.sql', 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL });
pool.query(sql).then(() => { console.log('OK'); pool.end(); }).catch(e => { console.error(e); pool.end(); process.exit(1); });
"
```

Use the `DATABASE_PUBLIC_URL` from memory: `project_accesssync_deployment.md`.

---

## Sign-off format

When ORION + FELIX complete:

```
STEP 01 COMPLETE — observability-foundation.sql applied to Railway DB
- 6 tables enriched with trace_id/actor_type/actor_id (member_access_log also gets mapping_id/hardware_group_id)
- activity_event table created with 5 indexes
- v_trace_timeline view compiled and verified
- FELIX checklist: all green
- DEPLOY SAFE: 90/90
```

Update `00_SPRINT_PLAN.md` status table: Step 1 → 🟢
