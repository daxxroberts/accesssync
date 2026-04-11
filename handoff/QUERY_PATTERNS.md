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

## Query Anti-Patterns (Do Not Do)

| Anti-Pattern | Why | Correct Pattern |
|-------------|-----|-----------------|
| `SELECT * FROM clients WHERE hardware_api_key IS NOT NULL` to check if setup complete | Doesn't account for location-level key | Check both client AND location keys |
| Calling Kisi API to get list of current members for comparison | Expensive, slow, hits rate limits | Query `member_role_assignments` instead |
| Writing to `member_role_assignments` outside standard-adapter.js | DR-023 violation | Route all state writes through Standard Adapter |
| `DELETE FROM member_role_assignments WHERE mapping_id = $1` | Deletes by mapping, not member — may affect other members on same mapping | Always delete by `member_id` for revoke operations |
| Checking `member_access_state.role_assignment_id` for current assignments | Legacy column (S-08) — not maintained | Query `member_role_assignments` table |
