---
file: DECISION_REGISTER.md
produced_by: QUILL
step: 2 of 9
handoff_version: 1.0.0
date: 2026-04-10
source: AccessSync/13_Decision_Records/ (35 DRs)
---

# DECISION REGISTER — AccessSync

Every locked architectural and business decision. Build reads these before writing code. No decision in this register is re-opened at the code level — if a gap is found, flag it and route back to KEEPER.

---

## How to Read This Register

- **Status: LOCKED** — Decision is sealed. Code must conform.
- **Status: DEFERRED** — Decision is made but implementation is post-V1 or post-HOG.
- **Status: PENDING** — Decision is documented but depends on an unresolved external item.
- **Build Impact** — What this means for the code, right now.

---

## DR-001 — No PII Storage for Primary Members

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** Primary member name, email, and personal data are NOT stored in AccessSync. They are fetched from Wix on demand when needed.  
**Rationale:** Data minimization. AccessSync does not need to store what it can retrieve. Reduces breach surface.  
**Exception:** Sub-members (plan holder's added members) store name, email, phone directly because Wix has no record of them — they are entered by the plan holder, not by Wix.  
**Build Impact:** `member_identity` for primary members has no name/email columns. Any screen needing member name must call the Wix member API. The operator members screen currently has no Wix name fetch — member names display as mock data (pre-HOG gap, not a violation of DR-001 itself).

---

## DR-002 — Bidirectional Access Adapter Layer

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** The hardware adapter layer is bidirectional — it both writes to hardware (grant/revoke) and reads from hardware (health check, lockdown state).  
**Rationale:** Adapter must be able to verify its own operations and respond to hardware-side state changes (lockdown, key expiry).  
**Build Impact:** HardwareAdapter exposes both write methods (createUser, assignGroup, removeGroup) and read methods (getGroups, checkHealth). No code outside the adapter calls hardware APIs directly.

---

## DR-003 — source_tag for Reconciliation Scope

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** All members created by AccessSync are tagged `source_tag = 'accesssync'` in `member_identity`. This distinguishes them from manually-added or staff users in the hardware system.  
**Rationale:** Reconciliation must only operate on AccessSync-managed members, not manually-added gym staff or admin accounts.  
**Build Impact:** All reconciliation queries filter `WHERE source_tag = 'accesssync'`. Never operate on members without this tag.

---

## DR-004 — member_access_log Table

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** All member access lifecycle events (provisioned, disabled, restored, revoked, deleted) are written to `member_access_log`. Includes credential type and value (encrypted).  
**Rationale:** Audit trail for operator and platform admin. Enables member timeline view in dashboard.  
**Build Impact:** Every status transition in the grant/revoke flow must write a `member_access_log` row. The member timeline drawer reads this table.

---

## DR-005 — Kisi Lockdown Override: Skip, Not Fail

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** When a Kisi lockdown is active for a door/group, AccessSync skips provisioning/revocation for that group — does not attempt the API call, does not log a failure. Status is set to `skipped_lockdown`. Nightly reconciliation corrects state drift after lockdown lifts.  
**Rationale:** A lockdown is intentional operator action. Generating errors and retries against a locked-down door is noise. Reconciliation handles eventual consistency.  
**Build Impact:**
- Lockdown flag stored per client per affected group (not yet in schema — verify implementation in kisi-connector.js).
- Before any Kisi API call, check lockdown flag. If set → skip, log `skipped_lockdown`.
- Nightly reconciliation sweeps `skipped_lockdown` status for retry.
- Dashboard: lockdown shows as status indicator, not error.

---

## DR-006 — Member Sync Screen is One-Time Setup Confirmation

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** The "sync status" / member sync screen is a setup confirmation view, not a live sync trigger. It confirms what AccessSync has provisioned, not what Wix has.  
**Rationale:** Full Wix↔Kisi resync is a post-V1 feature. The sync screen in V1 shows AccessSync's provisioned state only.  
**Build Impact:** sync-status.ejs reads `member_access_state` data, not Wix API data.

---

## DR-007 — Managed Users White Label

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync-created users in Kisi/Seam appear under the gym's Kisi org, not under any AccessSync-branded account. The gym owner sees their own members in their own Kisi dashboard.  
**Rationale:** Operators use their own Kisi subscription. AccessSync is an automation layer, not a Kisi middleman.  
**Build Impact:** All Kisi API calls use the operator's own API key. No AccessSync-owned Kisi org exists.

---

## DR-008 — Pricing Locked

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync pricing tiers (Base, Pro, Connect) are locked. No pricing logic changes without a new DR.  
**Build Impact:** `tier` column on `clients` and `locations`. No dynamic pricing logic in V1 code.

---

## DR-009 — Kisi Legal: API Connector Model, 2.3(ii) Flag Resolved

**Status:** LOCKED (attorney review recommended on reseller agreement)  
**Date:** 2026-03-12  
**Decision:** Kisi EULA Section 2.3(ii) does not block AccessSync's Connect tier commercial launch. AccessSync operates as an authorized agent of the Customer (gym owner) using customer-owned credentials. Not a Kisi reseller.  
**Remaining open item:** B3 Item #3 — actual reseller agreement from Kisi (Joe) must be attorney-reviewed before Connect tier commercial launch.  
**Build Impact:** Connect tier uses operator's own Kisi API key. Marketing copy must frame as "bring your own Kisi subscription." Never suggest AccessSync provides Kisi access.

---

## DR-010 — Config Alert Log

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** Configuration errors (missing plan mapping, missing door, expired credentials, lockdown detected, malformed payload) are logged to `config_alert_log`, not `error_queue`. They are configuration problems, not processing failures.  
**Rationale:** Error queue is for provisioning failures (members who should have access but don't). Config alerts are for operator setup issues.  
**Build Impact:** `config_alert_log` table. Alert types: `missing_door`, `missing_group`, `expired_credentials`, `lockdown_detected`, `malformed_payload`. Operator dashboard shows config alerts separately from error queue.

---

## DR-011 — Kisi Direct, Not Through Seam

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync connects to Kisi directly via the Kisi API, not through Seam's unified hardware layer. Seam is a separate integration path for non-Kisi hardware.  
**Rationale:** Kisi has a first-class direct API. Seam adds a middleman, an additional cost, and a dependency. Kisi and Seam are parallel adapter paths, not a parent/child relationship.  
**Build Impact:** `connectors/kisi.js` and `connectors/seam.js` are both direct API connectors. No Seam wrapper around Kisi calls.

---

## DR-012 — Core Engine Infrastructure

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync runs on Railway. Core Engine (server.js) and Admin Server (admin/server.js) are separate Railway services. Queue: BullMQ backed by Redis.  
**Build Impact:** Two server entry points. Environment variables scoped per service in Railway. BullMQ concurrency: 20. Redis URL via REDIS_URL env var.

---

## DR-013 — member_identity Schema

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `member_identity` holds: client_id, platform_member_id, source_platform, hardware_platform, hardware_user_id, source_tag. No name/email for primary members (DR-001). Sub-member fields nullable (first_name, last_name, email, phone) with plan_holder_id linkage.  
**Build Impact:** UNIQUE constraint on (client_id, source_platform, platform_member_id). Upsert on every webhook to avoid duplicates.

---

## DR-014 — Color System

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync uses a defined color palette for status indicators across all UI surfaces.  
**Build Impact:** UI-level — status colors are consistent across operator dashboard, admin hub, and member widget.

---

## DR-015 — Mobile-First Build Standard

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** All member-facing UI (Wix widget, member portal) is built mobile-first.  
**Build Impact:** Member widget CSS: mobile-first breakpoints. Operator portal (iframe) is desktop-assumed but should not break on mobile.

---

## DR-016 — Velo Direct Install for HOG

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** First client installation (House of Gains / Chad) uses Wix Velo direct install — not Wix App Market. App Market submission is post-HOG.  
**Build Impact:** No app market packaging required for HOG launch. Wix widget deployed directly via Velo.

---

## DR-017 — Regular Users for House of Gains

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** HOG uses standard Wix member accounts (not sub-members, not family plans) for V1. Sub-member and multi-member features are deferred.  
**Build Impact:** Sub-member code is in place but gated. HOG launch tests standard member provisioning only.

---

## DR-018 — last_sync_at on clients

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `clients.last_sync_at` tracks the last time a sync sweep ran for that client.  
**Build Impact:** Updated by reconciliation job on each sweep. Dashboard displays this timestamp.

---

## DR-019 — adapter_admin_log Fields

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `adapter_admin_log` captures: client_id, event_type, platform_member_id, hardware_user_id, role_assignment_id, result, configured_by, configured_at. Also doubles as admin action log (S-10 — split post-V1).  
**Build Impact:** Every hardware API call result is logged here. Also log admin actions (client_archived, api_key_rotated, etc.) to this table until split post-V1.

---

## DR-020 — Operator Email Alerts via Resend

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** Operator alerts (hardware key validation failure, HMAC spike) are sent via Resend to `notification_email`. Client-level fallback, location-level override.  
**Build Impact:** Resend integration. All alert sends must check `locations.notification_email → clients.notification_email → NULL (skip)`.

---

## DR-021 — Platform-Agnostic Member Identity

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `member_identity.platform_member_id` (formerly `wix_member_id`) is the platform-agnostic identifier. `source_platform` column distinguishes the source.  
**Build Impact:** Never reference `wix_member_id` in code. Use `platform_member_id`. JWT payload `uid` = Wix member ID = `platform_member_id` for Wix clients.

---

## DR-022 — Seven-Layer Architecture

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** AccessSync follows a strict 7-layer architecture: L1 Wix Connector → L2 Wix Adapter → L3 Standard Adapter → L4 Core Engine → L5 Hardware Adapter → L6 Kisi/Seam Connector → L7 Hardware API. No layer may call a layer more than one hop away.  
**Build Impact:** Layer violations are architectural bugs. Standard Adapter never calls Kisi directly. Core Engine never calls Wix API. All hardware calls go through L5 → L6 → L7.

---

## DR-023 — Standard Adapter Owns Identity, State, and Locks

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `core/standard-adapter.js` exclusively owns writes to `member_identity`, `member_access_state`, and `member_role_assignments`. No other code path writes to these tables.  
**Build Impact:** If you're writing to any of these three tables outside `standard-adapter.js`, it's a violation. Reconciliation, queue workers, and API routes must go through Standard Adapter for state changes.

---

## DR-024 — client_activity_summary Table

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** Daily event counts (events_received, grants_completed, revokes_completed, errors_count) are aggregated per client per day via UPSERT. Failures never block the grant/revoke path.  
**Build Impact:** `client_activity_summary` writes are fault-tolerant — wrap in try/catch, log failure, continue. Dashboard reads this for activity charts.

---

## DR-025 — Locations Table Schema

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `locations` table holds one row per physical site per client. Contains subscription state, hardware platform override, API key override, notification email override. `kisi_org_id` intentionally excluded (G-10 open — org structure unverified).  
**Build Impact:** Location config overrides client config. Always resolve in order: location → client → NULL. Do not add `kisi_org_id` until G-10 is resolved.

---

## DR-026 — Multi-Door: member_role_assignments

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** `member_role_assignments` stores one row per hardware role assignment per member per plan mapping per group. Replaces the single `role_assignment_id` on `member_access_state` for multi-door support. Standard Adapter exclusively owns writes.  
**Build Impact:** On grant: write one row per hardware group per mapping. On revoke: delete all rows for that member atomically (`completeRevoke`). The legacy `role_assignment_id` on `member_access_state` is kept for backwards compat (S-08) but is not the authoritative store.

---

## DR-027 — Per-Location Subscription Model

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** Billing and subscription status lives at the location level, not the client level. `locations.subscription_status` = active / inactive / lapsed. Lapse suspends all members at that location.  
**Build Impact:** `location-lapse.js` handles lapse → suspend. Check `locations.subscription_status` before any provisioning operation. A lapsed location blocks grants.

---

## DR-028 — API Key Storage: AES-256-GCM Encrypted

**Status:** LOCKED  
**Date:** 2026-03  
**Decision:** All hardware API keys and Wix API keys are stored encrypted in the database (AES-256-GCM). Decrypted at runtime in memory only. Keys are never stored or logged in plaintext.  
**Build Impact:** `encryptApiKey()` / `decryptApiKey()` / `_getKey()` — Community 22 in graph. All API key reads go through decryption. Encryption key stored in Railway env var (`ENCRYPTION_KEY`). Never log decrypted keys.

---

## DR-029 — Sub-Member ID Generation

**Status:** LOCKED (DEFERRED post-HOG)  
**Date:** 2026-04  
**Decision:** Sub-members get AccessSync-generated UUIDs as their hardware identity. They have no Wix member ID — they are entered by the plan holder, not registered in Wix.  
**Build Impact:** Sub-member `member_identity` rows have `platform_member_id` = generated UUID, `source_platform` = 'accesssync'. Do not attempt to look them up in Wix.

---

## DR-030 — Plan Holder Linkage

**Status:** LOCKED (DEFERRED post-HOG)  
**Date:** 2026-04  
**Decision:** Sub-members are linked to their plan holder via `member_identity.plan_holder_id` (FK to parent `member_identity.id`). Cascade revoke: when plan holder loses access, all sub-members are also revoked.  
**Build Impact:** On any revoke for a primary member, query `member_identity WHERE plan_holder_id = $memberId` and revoke all sub-members. `member_access_state.plan_holder_id` enables cascade operations.

---

## DR-031 — Upstream Explosion Prevention

**Status:** LOCKED  
**Date:** 2026-04  
**Decision:** A sub-member revoke or failure must never propagate upward to the plan holder's access. Sub-member failures are isolated.  
**Build Impact:** Sub-member error handling is scoped to the sub-member record only. Plan holder `member_access_state` is not touched by sub-member operations.

---

## DR-032 — Sub-Member Draft/Submit Workflow

**Status:** LOCKED (DEFERRED post-HOG)  
**Date:** 2026-04  
**Decision:** Sub-members are created in `draft` status (entered by plan holder but not yet provisioned). Transition to `submitted` triggers the grant flow. `member_identity.sub_member_status` = 'draft' | 'submitted' | NULL (primary members).  
**Build Impact:** Member portal sub-member form creates `draft` records. Submission triggers the standard grant flow for that sub-member.

---

## DR-033 — Unified Member Widget

**Status:** LOCKED  
**Date:** 2026-04  
**Decision:** The Wix-embedded member widget is a single unified widget that shows both primary member access status AND sub-member management in one view. Not two separate widgets.  
**Build Impact:** `GET /member/access-status` returns primary member status + all sub-member records. Widget renders both in one component.

---

## DR-034 — Multi-Source Grant/Revoke Architecture

**Status:** LOCKED  
**Date:** 2026-04-01  
**Implementation Status:** NOT YET BUILT (S-03 in schema.sql)  
**Decision:** A new `member_access_sources` junction table tracks WHY a member is in a hardware group (plan, booking, family plan). Grant adds a source row. Revoke removes a source row. Kisi DELETE is only called when the source row count for that member+group reaches zero.  
**Rationale:** Without this table, cancelling Plan A removes Kisi access even if Plan B still grants the same group — unsafe revoke. Also prevents duplicate Kisi API calls when multiple sources grant the same group.  
**Schema:**
```sql
CREATE TABLE member_access_sources (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id      UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    kisi_group_id  INTEGER NOT NULL,
    source_type    VARCHAR(50) NOT NULL,  -- 'plan' | 'booking' | 'family_plan'
    wix_plan_id    VARCHAR(255),
    wix_booking_id VARCHAR(255),
    valid_until    TIMESTAMP WITH TIME ZONE,  -- NULL = permanent
    granted_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (member_id, kisi_group_id, source_type, COALESCE(wix_plan_id, ''), COALESCE(wix_booking_id, ''))
);
```
**Build Impact — Pre-Grant:**
1. Check `member_access_sources`: does this member already have a row for this group?
2. If YES with `valid_until = NULL` (permanent): skip Kisi API call, insert source row only.
3. If YES with `valid_until` set and new grant is permanent: upgrade (call Kisi POST).
4. If NO: normal grant path, then insert source row.

**Build Impact — Revoke:**
1. DELETE source row.
2. COUNT remaining rows for member+group.
3. If COUNT > 0: skip Kisi DELETE. Log "revoke skipped — N sources remain."
4. If COUNT = 0: call Kisi DELETE. Remove `member_role_assignments` row.

**Kisi constraints relevant to this DR:**
- One role assignment per user per group (no duplicates).
- `access_enabled` is user-level only — no per-group suspension.
- Duplicate POST behavior: UNKNOWN — always check sources before calling.
- `valid_until` expiry auto-delete behavior: UNKNOWN — reconciliation handles both cases.

---

## DR-035 — Platform-Agnostic Column Renames

**Status:** LOCKED  
**Date:** 2026-04  
**Decision:** All Wix-specific and Kisi-specific column names were renamed to platform-agnostic equivalents. `wix_plan_id` → `source_plan_id`. `wix_member_id` → `platform_member_id`. `kisi_api_key` → `hardware_api_key`.  
**Build Impact:** No column in the schema contains a platform name. Code must use the new names. Three UI strings still say "Kisi app" (U-09) — these are UI-level violations to fix pre-HOG, not schema violations.

---

## Open Items Affecting Build (Not Yet DRs)

| ID | Description | Status |
|----|-------------|--------|
| U-09 | "Kisi app" hardcoded in onboard.ejs, sync-status.ejs, API key form | Pre-HOG fix |
| WIRE-G-01 | pending_hardware auto-resolution trigger on API key/mapping save | Pre-HOG build |
| G-08 | Live API test needed: Kisi duplicate POST and valid_until expiry behavior | Pre-HOG test |
| S-03 | member_access_sources table (DR-034) not yet in schema.sql | Railway migration needed |
| S-08 | Legacy role_assignment_id on member_access_state — retirement DR needed | Post-V1 |
| S-10 | adapter_admin_log dual-purpose — split post-V1 | Post-V1 |
| S-14 | webhook_log retention policy | Pre-scale |
| B3 Item #3 | Kisi reseller agreement attorney review | Pre-Connect tier commercial launch |

---

*QUILL — Step 2 of 9 complete. Next: Step 3 — IRIS maps all 16 screens.*
