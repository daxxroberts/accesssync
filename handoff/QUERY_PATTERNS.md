---
file: QUERY_PATTERNS.md
produced_by: NOVA + ORION
step: 6 of 9
handoff_version: 1.0.0
date: 2026-04-10
verified: Yes — queries extracted directly from source files
---

# QUERY PATTERNS — AccessSync

All critical database query patterns used in production. Verified against actual source code. Build uses these patterns — do not invent new approaches to the same problems.

---

## Pattern 1 — Tenant Resolution

**File:** `core/tenant-resolver.js`  
**Use:** Route incoming webhook to correct client. Called on every inbound webhook.  
**Cache:** In-memory Map, 5-minute TTL. Cache hit skips DB query.

```sql
SELECT id FROM clients
WHERE site_id = $1
AND status = 'active'
LIMIT 1
```

**Fallback (removed from Railway):** DEFAULT_TENANT_ID env var was used for bootstrapping. Removed. Unknown site_id now returns null → webhook dropped.

**Cache invalidation:** `tenantResolver.invalidate(siteId)` removes a single entry. Used when client status changes.

---

## Pattern 2 — Plan Mapping Resolution (Multi-Group)

**File:** `core/plan-mapping-resolver.js`  
**Use:** Resolve a Wix plan ID to all hardware groups it grants access to. Called on every grant job.  
**Returns:** Array of `{ mappingId, hardwareGroupId, hardwarePlatform, tierName, accessType, apiKey }`

```sql
SELECT pm.id,
       COALESCE(pmg.hardware_group_id, pm.hardware_group_id) AS hardware_group_id,
       pm.tier_name,
       pm.access_type,
       COALESCE(l.hardware_platform, c.hardware_platform) AS hardware_platform,
       COALESCE(l.hardware_api_key, c.hardware_api_key) AS hardware_api_key_enc
FROM plan_mappings pm
LEFT JOIN plan_mapping_groups pmg ON pmg.mapping_id = pm.id
LEFT JOIN locations l ON pm.location_id = l.id
JOIN clients c ON pm.client_id = c.id
WHERE pm.client_id = $1
  AND pm.source_plan_id = $2
  AND pm.status = 'active'
  AND (l.id IS NULL OR l.subscription_status = 'active')
  AND COALESCE(pmg.hardware_group_id, pm.hardware_group_id, '') != ''
```

**Key design decisions in this query:**
- `COALESCE(pmg.hardware_group_id, pm.hardware_group_id)` — multi-group via junction table, falls back to legacy single-group column
- `COALESCE(l.hardware_platform, c.hardware_platform)` — location override pattern (DR-028)
- `COALESCE(l.hardware_api_key, c.hardware_api_key)` — location API key override pattern
- `l.subscription_status = 'active'` — lapsed location blocks grants (DR-027)
- `l.id IS NULL` — legacy rows with no location_id pass through

**Wix-first disambiguation (no group yet):**
```sql
SELECT id FROM plan_mappings
WHERE client_id = $1 AND source_plan_id = $2 AND status = 'active'
LIMIT 1
```
Returns empty array `[]` (plan exists, no group) vs `null` (plan not recognized).

---

## Pattern 3 — Member Identity Upsert

**File:** `core/queue-worker.js` (via standard-adapter.js)  
**Use:** Create or update member record on every webhook. Idempotent.

```sql
INSERT INTO member_identity (client_id, platform_member_id, source_platform, hardware_platform)
VALUES ($1, $2, $3, $4)
ON CONFLICT (client_id, source_platform, platform_member_id) DO UPDATE
SET updated_at = CURRENT_TIMESTAMP
RETURNING id, hardware_user_id
```

**Notes:**
- Unique constraint: `(client_id, source_platform, platform_member_id)`
- Returns existing `hardware_user_id` if member was already provisioned
- `hardware_user_id` is null if member is new (hardware user not yet created)

---

## Pattern 4 — Member Role Assignments Write (Grant)

**File:** `core/standard-adapter.js` (DR-023 — exclusive owner)  
**Use:** Record hardware role assignment after successful grant. One row per hardware group.

```sql
INSERT INTO member_role_assignments (member_id, mapping_id, role_assignment_id, hardware_group_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (member_id, mapping_id, hardware_group_id) DO UPDATE
SET role_assignment_id = EXCLUDED.role_assignment_id
```

**Notes:**
- Unique constraint: `(member_id, mapping_id, hardware_group_id)`
- ON CONFLICT updates are idempotent — safe for retry
- `role_assignment_id` is the Kisi role assignment integer ID (stored as VARCHAR)

---

## Pattern 5 — Member Role Assignments Read (for Revoke)

**File:** `core/standard-adapter.js`  
**Use:** Get all role assignment IDs to pass to hardware adapter for removal.

```sql
SELECT role_assignment_id, hardware_group_id, mapping_id
FROM member_role_assignments
WHERE member_id = $1
```

**Notes:**
- Returns all active role assignments for this member
- Used by `processRevoke()` to know which Kisi role IDs to DELETE

---

## Pattern 6 — Member Role Assignments Delete (Revoke)

**File:** `core/standard-adapter.js` (completeRevoke)  
**Use:** Atomic delete of all role assignments for a member on revoke.

```sql
DELETE FROM member_role_assignments
WHERE member_id = $1
```

**Notes:**
- Atomic delete — all rows for member in single statement (DR-026)
- Called after hardware DELETE calls complete

---

## Pattern 7 — Member Access State Upsert

**File:** `core/standard-adapter.js`  
**Use:** Set member provisioning status. Called after grant or revoke completes.

```sql
INSERT INTO member_access_state (member_id, client_id, status, provisioned_at)
VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
ON CONFLICT (member_id) DO UPDATE
SET status = EXCLUDED.status,
    provisioned_at = CASE WHEN EXCLUDED.status = 'active' THEN CURRENT_TIMESTAMP ELSE member_access_state.provisioned_at END,
    updated_at = CURRENT_TIMESTAMP
```

**Transition states:**
- New grant → `active`
- Revoke → `revoked`
- Payment failed → `disabled`
- Payment recovered → `active`
- Hardware error (4xx) → dead-lettered (no state update in standard path)
- Hardware error (5xx after retries) → `failed`
- Pending hardware → `pending_hardware`
- Lockdown skip → `skipped_lockdown`

---

## Pattern 8 — Pending Hardware Query (for Re-Queue)

**File:** To be added to `admin/routes/operator.js` (WIRE-G-01 — NOT YET BUILT)  
**Use:** Find all members parked as pending_hardware for a client and re-queue them.

```sql
SELECT mas.member_id, mas.pending_plan_id
FROM member_access_state mas
WHERE mas.client_id = $1
  AND mas.status = 'pending_hardware'
```

**Scoped variant (for plan mapping save — re-queue only members whose pending plan matches):**
```sql
SELECT mas.member_id, mas.pending_plan_id
FROM member_access_state mas
WHERE mas.client_id = $1
  AND mas.status = 'pending_hardware'
  AND mas.pending_plan_id = $2
```

**Action after query:** For each row, enqueue a grant job to BullMQ with `memberId` and `clientId`.

---

## Pattern 9 — Nightly Reconciliation Sweep

**File:** `core/reconciliation.js`  
**Use:** Find members to retry during nightly reconciliation job.

```sql
SELECT mas.member_id, mas.client_id, mi.platform_member_id, mi.hardware_user_id, mi.hardware_platform
FROM member_access_state mas
JOIN member_identity mi ON mi.id = mas.member_id
WHERE mas.status IN ('failed', 'skipped_lockdown')
  AND mi.source_tag = 'accesssync'
```

**In-flight timeout reset:**
```sql
UPDATE member_access_state
SET status = 'pending_sync'
WHERE status = 'in_flight'
  AND updated_at < NOW() - INTERVAL '10 minutes'
RETURNING member_id, client_id
```

---

## Pattern 10 — Event Deduplication

**File:** `core/wix-connector.js` (or webhook-processor.js)  
**Use:** Check and record processed events. Written BEFORE job enqueue.

```sql
INSERT INTO processed_event_ids (event_id, client_id)
VALUES ($1, $2)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id
```

**Logic:** If `RETURNING` returns a row → new event (process it). If no row returned → duplicate (drop it).

**Note:** `client_id` is nullable at this point (S-01 known gap — tenant may not be resolved yet at dedup time).

---

## Pattern 11 — Error Queue Write

**File:** `core/retry-engine.js` / queue error handler  
**Use:** Dead-letter a failed job to error_queue.

```sql
INSERT INTO error_queue (client_id, member_id, event_type, payload, error_reason, plan_name, door_name)
VALUES ($1, $2, $3, $4, $5, $6, $7)
```

---

## Pattern 12 — Error Queue Dismiss

**File:** `admin/routes/operator.js`  
**Use:** Operator dismisses an error card.

```sql
UPDATE error_queue
SET status = 'resolved',
    resolved_at = CURRENT_TIMESTAMP,
    dismiss_note = $2,
    dismissed_by = 'admin'
WHERE id = $1
```

**Note:** `dismissed_by` is hardcoded 'admin'. Not yet scoped to actual operator identity.

---

## Pattern 13 — Member Access Log Write

**File:** `core/grant-revoke.js`  
**Use:** Audit trail entry for every lifecycle event.

```sql
INSERT INTO member_access_log (member_id, client_id, event_type)
VALUES ($1, $2, $3)
```

Event types: `provisioned`, `disabled`, `restored`, `revoked`, `deleted`

---

## Pattern 14 — Client Activity Summary UPSERT

**File:** Queue worker (fault-tolerant wrapper)  
**Use:** Daily aggregated event count per client.

```sql
INSERT INTO client_activity_summary (client_id, summary_date, grants_completed)
VALUES ($1, CURRENT_DATE, 1)
ON CONFLICT (client_id, summary_date) DO UPDATE
SET grants_completed = client_activity_summary.grants_completed + 1,
    updated_at = CURRENT_TIMESTAMP
```

**Critical:** This write is in a try/catch. Failure is logged but does not block the grant/revoke path.

---

## Pattern 15 — Config Alert Log Write

**File:** `core/plan-mapping-resolver.js`  
**Use:** Log configuration errors (missing plan mapping, missing door).

```sql
INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
VALUES ($1, 'missing_group', $2)
```

Also uses UPSERT pattern on `last_seen_at` for deduplication in some cases.

---

## Pattern 16 — Webhook Health Timestamp Update

**File:** `core/wix-connector.js`  
**Use:** Update `last_wix_webhook_at` on every accepted webhook.

```sql
UPDATE clients
SET last_wix_webhook_at = CURRENT_TIMESTAMP
WHERE id = $1
```

---

## Pattern 17 — Hardware API Key Lookup (for Revoke)

**File:** `core/grant-revoke.js`  
**Use:** Get decrypted API key for revoke operations. Uses client-level key.

```sql
SELECT hardware_api_key FROM clients WHERE id = $1
```

**Note:** Revoke uses client-level key only (comment in source: "multi-org per-location revoke is a future enhancement post-V1"). Grant operations use the per-mapping resolved key from Pattern 2.

---

## Pattern 18 — Member Access Status (Member Portal API)

**File:** `core/member-sync-api.js`  
**Use:** Return member status to Wix-embedded widget. JWT auth (RS256, Wix JWKS).

```sql
SELECT mi.id, mi.platform_member_id, mi.hardware_user_id, mi.hardware_platform,
       mas.status, mas.provisioned_at
FROM member_identity mi
JOIN member_access_state mas ON mas.member_id = mi.id
WHERE mi.client_id = $1
  AND mi.platform_member_id = $2
LIMIT 1
```

**Additional queries in same endpoint:**
- `SELECT * FROM member_access_log WHERE member_id = $1 ORDER BY created_at DESC LIMIT 10`
- `SELECT * FROM member_role_assignments WHERE member_id = $1`

**Auth:** `uid` from Wix JWT = `platform_member_id`. Client resolved from `site_id` in JWT.

---

## Pattern 19 — Detecting Actual Duplicate `member_access_sources` Rows

**Use:** Diagnostic sweeps that hunt for true duplicate source rows (post-OB-198 schema enforcement, the live DB should always return 0 rows from this query — any non-empty result is a real bug).
**Why this pattern exists:** OB-226 was filed FALSE_ALARM on 2026-05-27 because an ad-hoc subagent sweep used a coarse `GROUP BY (access_id, hardware_group_id, role_assignment_id)` — which flagged Daxx's 5 legitimately distinct DR-046 multi-plan rows (5 different `source_plan_id` values, same person + group + role assignment) as 4 "duplicates." Root cause: the sweep's grouping was narrower than the DR-046 canonical UNIQUE tuple. OB-229 filed to document this pattern.

### Correct query (GROUP BY full DR-046 UNIQUE tuple)

```sql
-- DR-046 canonical UNIQUE: (client_id, access_id, source_type, source_plan_id, hardware_group_id)
-- Any row returned is a real duplicate — the UNIQUE constraint should have blocked it.
SELECT client_id, access_id, source_type, source_plan_id, hardware_group_id, COUNT(*) AS dup_count
FROM   member_access_sources
WHERE  status = 'active'           -- scope to active rows; widen if auditing all statuses
GROUP  BY client_id, access_id, source_type, source_plan_id, hardware_group_id
HAVING COUNT(*) > 1;
```

**Expected result on live DB:** 0 rows. The UNIQUE constraint enforced post-OB-198 makes a duplicate row physically impossible — if this returns anything, the constraint has been dropped or violated. Treat any non-empty result as Tier 3 surface to SAGE.

### Wrong query shapes — DO NOT USE for duplicate detection

```sql
-- WRONG #1: GROUP BY (access_id, hardware_group_id, role_assignment_id) only.
-- This is what OB-226 used. Flags Daxx's 5 legitimate multi-plan rows on group 838622
-- (one role_assignment_id covers all 5 plans — that is the point of DR-046's per-plan tracking).
SELECT access_id, hardware_group_id, role_assignment_id, COUNT(*)
FROM   member_access_sources
WHERE  status = 'active'
GROUP  BY access_id, hardware_group_id, role_assignment_id
HAVING COUNT(*) > 1;
-- ^^ DO NOT USE. Returns false positives for any DR-046 multi-plan-same-group member.

-- WRONG #2: GROUP BY (member_access.member_master_id, hardware_group_id).
-- Same class of error. One person CAN legitimately have N source rows for the same group
-- when N distinct plans grant that group (the canonical sub-member + holder family case).
```

### Why DR-046 multi-plan-same-group is intentional (not duplication)

DR-046 schema-spec'd the per-source-row tuple so that **each (member × client × source_type × source_plan_id × hardware_group_id)** combination is a separate row by design:

- Family plans: a holder + 4 sub-members on Couples plan → 5 source rows, all for the same hardware_group_id, each with a distinct `source_plan_id` (per the DR-029 sub-member ID format).
- Operator-side: one person can hold multiple distinct plans that all grant the same door — each plan is independently revocable (DR-034 pre-grant source check + remaining-count check on revoke).
- The single Kisi `role_assignment_id` is shared across these rows because Kisi physically only allows one role assignment per user per group (per Kisi API docs verified 2026-05-02). The DB tracks 1:N grant reasons; Kisi tracks the 1:1 hardware fact.

**Counter-example test (verified live 2026-05-27):**
`daxxroberts@gmail.com` has 5 active rows on `hardware_group_id='838622'`, all sharing `role_assignment_id='98601860'`, with 5 distinct `source_plan_id` values:
`0d478601-...`, `2c126a17-...`, `2dcaf897-...`, `7861f180-...`, `87e831a4-...`.
The correct query returns 0 (no dupes); the wrong query returns 1 row with `misflag_count=5`.

### Diagnostic checklist when a sweep flags "duplicates"

1. Is the `GROUP BY` the full DR-046 UNIQUE tuple `(client_id, access_id, source_type, source_plan_id, hardware_group_id)`? If not, the result is suspect.
2. Re-run with the canonical tuple. If 0 → false alarm (close the OB as FALSE_ALARM, cite OB-226).
3. If > 0 → real bug. UNIQUE constraint failed or was dropped. Tier 3 surface to SAGE.

---

## Query Anti-Patterns (Do Not Do)

| Anti-Pattern | Why | Correct Pattern |
|-------------|-----|-----------------|
| `SELECT * FROM clients WHERE hardware_api_key IS NOT NULL` to check if setup complete | Doesn't account for location-level key | Check both client AND location keys |
| Calling Kisi API to get list of current members for comparison | Expensive, slow, hits rate limits | Query `member_role_assignments` instead |
| Writing to `member_role_assignments` outside standard-adapter.js | DR-023 violation | Route all state writes through Standard Adapter |
| `DELETE FROM member_role_assignments WHERE mapping_id = $1` | Deletes by mapping, not member — may affect other members on same mapping | Always delete by `member_id` for revoke operations |
| Checking `member_access_state.role_assignment_id` for current assignments | Legacy column (S-08) — not maintained | Query `member_role_assignments` table |

---

## Pattern N — Trace Timeline (v_trace_timeline)

**View:** `v_trace_timeline` (defined in `migrations/dr-041.sql`)
**Use:** Powers the Admin Trace Timeline UI. UNION ALL across 7 log tables, LEFT JOIN trace_context for enrichment.
**Sources unified:** `activity_event` (`source='activity'`), `webhook_log` (`source='webhook'`), `diagnostic_log` (`source='diagnostic'`), `member_access_log` (`source='member_access'`), `error_queue` (`source='error_queue'`), `adapter_admin_log` (`source='admin_audit'`), `config_alert_log` (`source='config_alert'`).
**Filter discipline:** ALWAYS bound by `ts` time window. The view UNIONs 7 tables — unbounded queries scan all of them.

### Pattern N.1 — Trace Timeline: events feed (paginated)

**Use:** `GET /admin/logs/events` — primary feed. Default 24h window, max 7d.
**Indexes touched:** per-source `created_at`/`received_at`/`ts` indexes; trace_context PK on JOIN.

```sql
SELECT trace_id, ts, source, actor_type, actor_id, event,
       target_type, target_id, result, detail, client_id,
       client_name, member_name, member_email,
       source_platform, hardware_platform, hardware_user_id,
       plan_name, door_name, entry_point
FROM v_trace_timeline
WHERE ts >= $1                              -- since (e.g. NOW() - INTERVAL '24 hours')
  AND ($2::timestamptz IS NULL OR ts < $2)  -- until (optional)
  AND ($3::text IS NULL OR source = $3)     -- source filter
  AND ($4::text IS NULL OR result = $4)     -- severity proxy (level/result column)
  AND ($5::uuid IS NULL OR client_id = $5)  -- client_id filter
  AND ($6::text IS NULL OR trace_id = $6)   -- trace_id filter
ORDER BY ts DESC
LIMIT $7 OFFSET $8;
```

**Defaults:** `since = NOW() - INTERVAL '24 hours'`, `limit = 100`, `offset = 0`. Hard-cap `limit` server-side at 500.

**Severity derivation (post-fix needed):** the view's `result` column carries different semantics per source (HMAC status, error level, success/failed). MVP UI maps `result` → severity client-side. Future migration may add a derived `severity` column to the view.

### Pattern N.2 — Trace Timeline: typeahead search

**Use:** `GET /admin/logs/typeahead` — typeahead-style search across members, clients, traces. Drives the search box in the Trace Timeline UI.
**Index:** `idx_trace_context_fts` (GIN on `to_tsvector` of name columns) — built into dr-041.

```sql
-- Member matches (FTS on member_name + email + platform_member_id + hardware_user_id)
SELECT DISTINCT ON (member_id)
       'member' AS kind, member_id, member_name, member_email,
       client_id, client_name, platform_member_id, hardware_user_id,
       MAX(started_at) AS last_seen
FROM trace_context
WHERE member_id IS NOT NULL
  AND to_tsvector('english',
        coalesce(client_name,'') || ' ' || coalesce(member_name,'') || ' ' ||
        coalesce(member_email,'') || ' ' || coalesce(platform_member_id,'') || ' ' ||
        coalesce(hardware_user_id,'') || ' ' || coalesce(plan_name,'') || ' ' ||
        coalesce(door_name,'')
      ) @@ websearch_to_tsquery('english', $1)
GROUP BY member_id, member_name, member_email, client_id, client_name,
         platform_member_id, hardware_user_id
ORDER BY member_id, last_seen DESC
LIMIT 5;

-- Client matches (simple ILIKE — small table, GIN index unnecessary)
SELECT id AS client_id, name AS client_name
FROM clients
WHERE name ILIKE '%' || $1 || '%'
  AND status = 'active'
LIMIT 3;

-- Trace ID matches (exact prefix only — UUIDs are not searchable text)
SELECT trace_id, started_at, client_name, member_name, plan_name, door_name, entry_point
FROM trace_context
WHERE trace_id::text LIKE $1 || '%'
ORDER BY started_at DESC
LIMIT 4;
```

**FAULT.2 mitigation:** typeahead must also surface traces where `member_id IS NULL` but a free-text token (email, plan_id) appears in raw event payload. Without that, operators searching for a failed sign-up find nothing — the failure they most need to find is invisible. Implement as a fallback against `webhook_log.normalized_payload` and `error_queue.payload` JSONB when no member_id matches the query:

```sql
-- Fallback: search raw payloads when no resolved-member match
SELECT 'untraced' AS kind, trace_id, ts, source, event, client_id
FROM v_trace_timeline
WHERE ts > NOW() - INTERVAL '7 days'
  AND member_name IS NULL
  AND detail::text ILIKE '%' || $1 || '%'
ORDER BY ts DESC
LIMIT 5;
```

### Pattern N.3 — Trace Timeline: full trace by ID

**Use:** `GET /admin/logs/trace/:trace_id` — drawer detail view. Returns every event in one trace, ordered chronologically.

```sql
SELECT trace_id, ts, source, actor_type, actor_id, event,
       target_type, target_id, result, detail, client_id,
       client_name, member_name, member_email,
       source_platform, hardware_platform, hardware_user_id,
       plan_name, door_name, entry_point
FROM v_trace_timeline
WHERE trace_id = $1
ORDER BY ts ASC;
```

**Caps:** unbounded — a trace exceeding 100 events is a smell that should surface to FORGE for UI handling. Server returns full result; UI may paginate.

### Pattern N.4 — Trace Timeline: source breakdown for stat strip

**Use:** Sparkbar / stat strip on Trace Timeline UI. Aggregates 24h activity by source.

```sql
SELECT source, COUNT(*) AS n
FROM v_trace_timeline
WHERE ts > NOW() - INTERVAL '24 hours'
  AND ($1::uuid IS NULL OR client_id = $1)
GROUP BY source
ORDER BY n DESC;
```

### Pattern N.5 — Trace Timeline: writes (NOT applicable)

`v_trace_timeline` is read-only. Writes to its underlying tables follow the **trace_id threading rule (DR-037, enforced by `test/p3-data-integrity/log-table-trace-id.test.js`):**

> Every `INSERT INTO <log table>` in `core/`, `adapters/`, or `admin/` MUST include `trace_id, actor_type, actor_id` in its column list, with values pulled from `getTraceId()` and `getActor()` of `core/trace-context.js`.

Reference implementation: `admin/middleware/activity.js` (`recordActivity` helper). All 14 INSERT call sites updated 2026-04-28 (commit `d434b91`).

### Pattern N.6 — trace_context enrichment (write side)

**File:** `core/trace-context.js` — `setTraceContext(traceId, opts)`
**Use:** Backfill member/plan/door/mapping context after entry-point mint, when those fields resolve mid-request.

```sql
UPDATE trace_context
SET client_id  = COALESCE(client_id,  $2),
    member_id  = COALESCE(member_id,  $3),
    member_name= COALESCE(member_name,$4),
    -- ... (all fields built dynamically; only NULL slots upgrade)
    plan_name  = COALESCE(plan_name,  $N),
    door_name  = COALESCE(door_name,  $N+1),
    mapping_id = COALESCE(mapping_id, $N+2)
WHERE trace_id = $1;
```

**Call sites (all fire-and-forget via `setImmediate`):**
- `adapters/standard-adapter.js#resolveAndLock` — adds `memberId` (triggers re-resolution of member name + hardware identifiers from `member_identity`)
- `core/plan-mapping-resolver.js#resolve` — adds `planName`, `doorName`, `mappingId`
- `core/webhook-processor.js#processWebhook` — backfills `clientId` once tenant resolves
- `core/queue-worker.js` — full enrichment after identity resolution (replaces no-op `registerTrace` ON CONFLICT DO NOTHING)

**Why COALESCE not overwrite:** entry-point middleware writes the row first; mid-request callers only fill NULLs to avoid clobbering known-good values. This is the only safe pattern for fire-and-forget concurrent UPDATE.

---

## Trace Timeline — Performance Notes

EXPLAIN ANALYZE on Railway prod (2026-04-28, view at 1,865 trace_context rows + 360 log rows): pattern N.1 with 24h window completes in **0.4ms**. Sort is on `ae.ts DESC` from the `activity_event` arm; trace_context JOIN uses PK index. No table scans observed.

**Volume thresholds where re-audit is warranted:**
- v_trace_timeline rows > 100k → check that all per-source `created_at` indexes are still hit (current indexes verified via STEP_01 of logging sprint)
- trace_context rows > 1M → consider partitioning by `started_at` (monthly partitions)
- typeahead query > 50ms → re-check `idx_trace_context_fts` GIN index health
