---
file: CIRCUIT_REVIEW.md
produced_by: CIRCUIT
step: 5 of 9
handoff_version: 1.0.0
date: 2026-04-10
verdict: CONDITIONAL — 2 pre-build requirements, 1 minor gap, 2 deferred post-HOG
---

# CIRCUIT REVIEW — AccessSync Architecture Assessment

CIRCUIT's architectural review of the AccessSync system before any Build session begins. Evaluates agentic patterns, async flows, queue architecture, and integration surface for structural risks.

---

## System Classification

AccessSync is an **event-driven middleware** with the following architectural characteristics:

| Characteristic | Assessment |
|---------------|------------|
| Primary trigger | Inbound webhook (Wix → Core Engine) |
| Processing model | Queue-based (BullMQ/Redis), concurrency 20 |
| State persistence | PostgreSQL (Railway) |
| External integrations | Wix API (outbound), Kisi API (outbound), Seam API (outbound), Resend (outbound) |
| Auth model | 3 JWT types + Wix HMAC + Google OAuth |
| Multi-tenancy | Full — site_id routing, no shared state between tenants |

---

## Architecture Assessment

### Strengths

**1. Clean separation of concerns**
The 7-layer architecture (DR-022) is well-enforced. Wix Connector handles only inbound processing. Standard Adapter owns all state writes (DR-023). Hardware adapters are isolated. No layer knows more than it needs to.

**2. Idempotent deduplication**
event_id written to `processed_event_ids` before job enqueue. Duplicate webhooks are rejected at the connector layer before any state changes. Correct placement — dedup happens early.

**3. Living access record design**
`member_role_assignments` as the authoritative comparison layer eliminates the need to call Kisi API to audit current state. This is architecturally sound and scales correctly. Hardware API is called only for delta operations.

**4. Fault-tolerant activity tracking**
`client_activity_summary` UPSERT failures are explicitly non-blocking. The pattern (try/catch, continue) is correctly applied — failures in telemetry must not affect the grant/revoke path.

**5. Lockdown skip pattern (DR-005)**
Skipping rather than failing on lockdown is the right call. Generates no false errors, respects operator authority, and reconciliation handles eventual consistency.

---

## Structural Risks

### RISK-01 — member_access_sources Not Built [BLOCKING — Pre-HOG]

**Severity:** HIGH  
**File:** schema.sql (S-03 known gap)  
**DR:** DR-034

The `member_access_sources` table is LOCKED in the decision register but does not exist in the schema. Without it, the revoke path has an unsafe behavior: cancelling one Wix plan removes Kisi access even if a second plan grants the same group.

**Affected flow:** Flow 4 (Revoke), any multi-source scenario.

**Required before build:**
1. Add `member_access_sources` to schema.sql and deploy Railway migration
2. Update `completeGrant()` in standard-adapter.js to check sources before calling Kisi
3. Update `completeRevoke()` to check remaining sources before calling Kisi DELETE
4. Nightly reconciliation gains new source-vs-Kisi comparison

**Assessment:** This is a data integrity risk, not just a feature gap. If HOG members have multiple active plans (e.g., membership + class booking both granting the same door), a cancel on one will incorrectly revoke access. For HOG's simple case (single plan per member), this may not trigger — but it is architecturally broken.

---

### RISK-02 — pending_hardware Auto-Resolution [RESOLVED]

**Severity:** N/A — Already built  
**Location:** admin/routes/operator.js — `retryPendingHardwareMembers()` function (line 49)

`retryPendingHardwareMembers(clientId)` is implemented and called in 3 places:
- Line 277: Client API key save (onboarding)
- Line 400: Client API key rotate (operator)  
- Line 594: Location API key save

**Remaining gap (minor):** `retryPendingHardwareMembers` is called on API key save but NOT on plan mapping save. Members parked because a plan had no group mapping will not auto-retry when the operator maps the plan. Consider adding the call to the plan mapping save handler — scope it to pending members whose `pending_plan_id` matches the updated `source_plan_id`.

---

### RISK-03 — U-09: Hardcoded "Kisi app" Strings [BLOCKING — Pre-HOG]

**Severity:** MEDIUM  
**Files:**
- `admin/views/pages/onboard.ejs` — API key input label
- `admin/views/pages/sync-status.ejs` — Member-facing active state copy
- `admin/routes/operator.js` or related — API key form label

**DR:** DR-035 (platform-agnostic column names)

These three "Kisi app" strings violate the platform-agnostic design principle. For HOG (Kisi), this is cosmetically incorrect but functionally fine. For any Seam client, this is a product defect.

**Required before HOG:** Replace all three with platform-agnostic copy:
- API key label: "Hardware API Key" or "Access Control API Key"
- Member sync status copy: "You can now access the gym using your [hardware app]" (dynamic from hardware_platform) or generic "You're all set — your access is now active."

---

### RISK-04 — Kisi valid_until and Duplicate POST Behavior Unknown [Monitor — Pre-HOG]

**Severity:** MEDIUM  
**DR:** DR-034 (G-08 open item)

Two Kisi API behaviors are undocumented:
1. What happens when a duplicate POST to the same user+group is made (overwrite? 409? 422?)
2. What happens when a `valid_until` time passes — does Kisi auto-delete the role assignment or just stop granting access?

**Required before HOG:** Live API test against actual Kisi sandbox with Chad's org. Document results. Update DR-034 with confirmed behavior. Standard Adapter should defensively check `member_access_sources` before any POST (once RISK-01 is resolved) to avoid hitting the unknown duplicate behavior.

---

### RISK-05 — DEFAULT_TENANT_ID Removed [RESOLVED]

Previously, an unknown site_id was routing to a hardcoded fallback client (HOG production data). This was removed from Railway env vars. Confirmed resolved — unknown site_id now returns 401. No action needed.

---

### RISK-06 — webhook_log Retention [Deferred — Pre-Scale]

**Severity:** LOW  
**Schema gap:** S-14

`webhook_log` stores full JSONB payloads with no TTL or partition. At scale (many clients, high webhook volume), this table will grow unbounded.

**Required before scale:** Implement TTL (delete rows older than 30/60 days) or partition by month. Not blocking for HOG launch.

---

### RISK-07 — adapter_admin_log Dual Purpose [Deferred — Post-V1]

**Severity:** LOW  
**Schema gap:** S-10

`adapter_admin_log` serves as both hardware provisioning audit trail and admin action log. Dual purpose makes querying and display logic messy.

**Required post-V1:** Split into two tables. Not blocking for HOG.

---

## Queue Architecture Assessment

**BullMQ (Redis):** Correctly configured. Concurrency 20 is appropriate for Railway's single-instance deployment. Rate limiting against Kisi API should be considered as member count grows — Kisi API rate limits are not documented in current vault (recommend adding to Kisi_Setup_Knowledge_Base.md).

**Job failure paths:**
- 4xx (UnrecoverableError) → dead-lettered to error_queue. Correct — no retry on client errors.
- 5xx → RetryEngine with exponential backoff. Correct.
- `in_flight` >10 minutes → reconciliation resets to `pending_sync`. Correct safety net.

**Dedup timing:** event_id written before job enqueue. If enqueue fails after dedup write, the event is lost (not retried). This is an acceptable tradeoff — the alternative (write after enqueue) risks duplicate processing. Documented in APP_CONTEXT.md (Critical Rule 5).

---

## Integration Surface Assessment

| Integration | Direction | Auth | Risk |
|-------------|-----------|------|------|
| Wix webhook → AccessSync | Inbound | HMAC-SHA256 | Low — validated before processing |
| AccessSync → Kisi API | Outbound | Operator API key (AES-256-GCM encrypted at rest) | Medium — key rotation not automated |
| AccessSync → Seam API | Outbound | Operator API key | Same as Kisi |
| AccessSync → Wix API | Outbound | Wix API key (encrypted) | Medium — used for member name fetch and plan list |
| AccessSync → Resend | Outbound | Resend API key (env var) | Low |
| Member JWT → Wix JWKS | Inbound validation | RS256, JWKS cached 1h | Low |

**Key rotation gap:** No automated key rotation for hardware API keys. If a gym rotates their Kisi API key, the operator must manually update it in System Config. Hardware key validation health check runs on schedule — expired key will generate an alert within the check interval.

---

## CIRCUIT Sign-Off

**Verdict:** CONDITIONAL

The architecture is sound. The 7-layer separation, queue design, deduplication, and living access record pattern are all well-reasoned and correctly implemented.

**Two pre-build requirements (blocking):**
1. [RISK-01] Add `member_access_sources` schema + update grant/revoke logic
2. [RISK-03] Replace "Kisi app" hardcoded strings (U-09)

**One minor gap (non-blocking but recommended):**
3. [RISK-02 — resolved, minor remaining] Add `retryPendingHardwareMembers` call to plan mapping save handler

**Two deferred (post-HOG/post-V1):**
4. [RISK-04] Live Kisi API test for duplicate POST and valid_until behavior
5. [RISK-06] webhook_log retention policy (pre-scale)

Build may proceed on all screens and flows that do not touch the grant/revoke path. The grant/revoke path (Standard Adapter + hardware connector) must not be modified until RISK-01 is resolved.

---

*CIRCUIT — Step 5 of 9 complete.*
