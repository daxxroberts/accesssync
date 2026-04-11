---
file: APP_CONTEXT.md
produced_by: QUILL
step: 1 of 9
handoff_version: 1.0.0
date: 2026-04-10
---

# APP_CONTEXT — AccessSync

---

## What This Is

AccessSync is a multi-tenant SaaS middleware that bridges **Wix** (source of truth for gym memberships and bookings) and **physical access control hardware** (Kisi, Seam). When a gym member buys a plan or books a class on a Wix site, AccessSync automatically provisions their access in the hardware system — no manual entry by gym staff. When they cancel, access is revoked. The system runs entirely on webhooks and a queue worker; there is no polling loop.

---

## Who Uses It

| Role | Identity | What They Do |
|------|----------|--------------|
| **Platform Admin** | Daxx Roberts | Manages all clients via Admin Hub. Monitors error queues, debug tools, webhook health across all tenants. |
| **Operator** | Gym owner / staff (e.g. Chad at HOG) | Configures API keys, plan→door mappings, locations. Views member access status and error queue for their gym. Accesses via Wix Dashboard sidebar (iframe portal). |
| **Gym Member** | End user | Buys plan or books class on Wix. Never touches AccessSync directly — their access is provisioned silently. Can view sync status via Wix-embedded member widget. |

---

## The Core Loop

```
Wix fires webhook (plan.purchased / booking.confirmed / plan.cancelled / etc.)
  → HMAC validated (wix-connector.js)
  → Dedup check: event_id not in processed_event_ids
  → Tenant resolved: site_id → clients record
  → Event marked processed
  → Job enqueued to BullMQ (concurrency 20)

Queue worker picks up job
  → Member identity upserted (member_identity)
  → Plan mapping resolved:
      null           → drop (plan not managed)
      []             → park as pending_hardware (no group mapped yet)
      [mappings]     → proceed
  → API key resolved:
      missing        → park as pending_hardware
      found          → proceed
  → Hardware adapter called: create user + assign groups
  → member_role_assignments rows written (one per hardware group)
  → member_access_state: status = 'active'
```

Every grant writes to `member_role_assignments`. Every revoke deletes all rows for that member atomically. This table is the living access record — it answers "who has access right now" without calling the hardware API.

---

## The Data Model — Plain English

**`clients`** — One row per gym (tenant). Holds the Wix site_id for webhook routing, encrypted hardware API key (org-level), encrypted Wix API key, billing tier, and webhook health timestamp.

**`locations`** — One row per physical location under a client. Can override the client-level hardware platform, API key, and notification email. Subscription status lives here (active/inactive/lapsed).

**`plan_mappings`** — The translator. Maps a Wix plan ID or booking service ID to one or more hardware group IDs. One plan → multiple doors supported via `plan_mapping_groups` junction table. Legacy rows fall back to `plan_mappings.hardware_group_id`.

**`plan_mapping_groups`** — Junction table. One row per hardware group per plan mapping. Resolver JOINs this table to expand multi-door grants.

**`member_identity`** — One row per member per client. Holds the Wix member ID (platform_member_id), the hardware user ID, and sub-member linkage. Primary members: name/email fetched from Wix on demand (data minimization — DR-001). Sub-members: name/email stored directly (entered by plan holder — deferred post-HOG).

**`member_access_state`** — One row per member. Tracks provisioning status: `pending_sync`, `in_flight`, `active`, `disabled`, `revoked`, `failed`, `skipped_lockdown`, `pending_hardware`.

**`member_role_assignments`** ← **The living access record.** One row per hardware group assignment per member. Written on every grant, deleted atomically on every revoke. This table is the comparison layer for all sync operations. The hardware API is never called to audit current state — only to act on delta.

**`error_queue`** — Dead letter queue. UnrecoverableError (4xx) and max-retry exhausted jobs land here. Operator dismisses or retries from dashboard.

**`processed_event_ids`** — Dedup table. event_id written before job enqueue. Duplicate webhooks rejected here.

**`webhook_log`** — Full webhook log including raw + normalized payload. No retention policy yet (S-14 known gap).

**`config_alert_log`** — Config alerts: missing plan mapping, expired credentials, lockdown detected.

**`adapter_admin_log`** — Dual-purpose audit log: hardware provisioning trail + admin actions (key rotation, client archive). Split into two tables post-V1 (S-10).

**`client_activity_summary`** — Daily aggregated event counts per client. Fault-tolerant UPSERT — failures never block grant/revoke.

---

## Critical Rules

### 1. NULL Hierarchy — API Keys and Platform
Resolution order for any hardware operation:
```
locations.hardware_api_key → (NULL) → clients.hardware_api_key
locations.hardware_platform → (NULL) → clients.hardware_platform
locations.notification_email → (NULL) → clients.notification_email
```
If both are NULL, the operation fails. This is expected behavior — no key = no access provisioning.

### 2. pending_hardware — Park and Resolve
When a member purchases before setup is complete (no API key or no plan mapping):
- `member_access_state.status = 'pending_hardware'`
- `pending_plan_id` stored for re-queue

**Resolution trigger:** When operator saves an API key OR creates/updates a plan mapping, AccessSync queries all `pending_hardware` members for that client and re-queues them through the standard grant flow.

The nightly reconciliation does **not** sweep `pending_hardware`. It is a configuration gap, not a processing failure.

### 3. Platform-Agnostic Patterns
All column names are platform-agnostic (DR-035): `source_plan_id` (not wix_plan_id), `platform_member_id` (not wix_member_id), `hardware_api_key` (not kisi_api_key). All hardcoded "Kisi app" strings have been removed from the UI (U-09 closed 2026-04-10). All member-facing and operator-facing copy is now platform-agnostic.

### 4. Member Name Resolution Gap
The members API endpoint (`GET /operator/members`) returns `platform_member_id` only — no name or email from Wix. The members.ejs UI currently displays mock data (hardcoded firstName/lastName/email, lines 256-275). In production, member display falls back to splitting the platform_member_id string. This is a known gap — no DR exists yet for Wix member name fetch on the operator dashboard.

### 5. Deduplication is Pre-Queue
event_id is written to `processed_event_ids` before the job is enqueued. If processing fails after this point, the event will not be retried via re-delivery — it will land in error_queue and require operator action.

### 6. Hardware Adapter Owns member_role_assignments
The Standard Adapter Layer (`core/standard-adapter.js`) exclusively owns writes to `member_role_assignments` (DR-023). No other code path writes to this table.

### 7. Revoke is Atomic
`completeRevoke()` deletes all `member_role_assignments` rows for a member in a single transaction. Partial revokes do not exist.

---

## Configuration Flags

| Flag | Table | Default | Behavior |
|------|-------|---------|----------|
| `hardware_platform` | clients / locations | Required | 'kisi' or 'seam'. Location overrides client. |
| `hardware_api_key` | clients / locations | NULL | Encrypted. Location overrides client. NULL = no provisioning. |
| `wix_api_key` | clients | NULL | Encrypted. Used for outbound Wix plan/booking API calls. |
| `notification_email` | clients / locations | NULL | Resend alert destination. Location overrides client. NULL = no email alerts. |
| `subscription_status` | locations | 'inactive' | 'active', 'inactive', 'lapsed'. Lapse suspends all location members. |
| `first_grant_sent` | clients | false | Sprint 5.5: tracks whether first grant welcome email has been sent. |
| `status` | plan_mappings | 'active' | 'active' or 'excluded'. Excluded = "Not managed" in UI. |
| `allow_multiple` / `max_members` | plan_mappings | false / 1 | Multi-member gates — deferred post-HOG. |

---

## Completion Logic — Setup Check

When an operator opens the portal for the first time (via Wix Dashboard sidebar):

```
GET /operator-portal?instance=<wix_instance>
  → Wix signed instance verified
  → Client record resolved (three-path lookup: wix_instance_id → wix_api_key decode → site_id)
  → JWT issued (8h, sameSite: none for iframe)
  → Setup check:
      no API key AND no locations → redirect to /operator-portal/setup → portal-setup.ejs
      otherwise → redirect to /dashboard?clientId=X
```

**portal-setup.ejs** is a static welcome card ("Welcome to AccessSync", "Start Setup" CTA). It links to `/onboard?clientId=<clientId>`. This is the real first-run screen — not `/onboard` directly.

Known gap (FUNNEL-G-15): If an operator has an API key but no locations, or locations but no API key, they go to dashboard directly without completing setup. This edge case has no guard.

---

## Navigation Model

### Two Servers
| Server | Entry | Purpose |
|--------|-------|---------|
| **Core Engine** (`server.js`) | Railway public URL | Receives Wix webhooks + serves member portal API. 3 endpoints: `/health`, `/webhooks/wix`, `/member/access-status` |
| **Admin Server** (`admin/server.js`) | Separate Railway service | Full operator dashboard + Admin Hub. All operator and admin routes. |

### Admin Hub (Platform Admin — Daxx)
Login screen → 6-tab dashboard:
1. **Error Queue** — failed provisioning events, dismiss/retry
2. **Debug Center** — member lookup, manual sync triggers
3. **Webhook Inspector** — full webhook log with payload viewer
4. **Queue Monitor** — BullMQ job status
5. **Clients** — all tenants, archive/manage
6. **Member Sync** — sync operations (scope TBD)

### Operator Portal (Gym Owner — iframe in Wix Dashboard)
Entry: Wix Dashboard sidebar → `/operator-portal?instance=` → JWT → portal-setup.ejs (first run) or `/dashboard`

Dashboard tabs:
1. **System Config** — hardware platform, org-level API key, Wix API key, notification email
2. **Locations** — per-location config (platform, API key, email, subscription status), + Add Location
3. **Plan Mappings** — plan→door mapping table, status toggle (managed/excluded)
4. **Members** — member list with access status, timeline drawer
5. **Sync Status** — provisioning health summary, error queue for this client
6. **Error Queue** — dismissible error cards with retry

### Member Widget (Wix-Embedded)
Single Wix-embedded widget. Calls `GET /member/access-status` with Wix JWT (RS256). Returns member provisioning status + role assignments. Renders active plans, hardware credential type, and sub-member management UI (post-HOG).

---

## Architecture — 7 Layers

```
L1  Wix Connector        wix-connector.js         HMAC verify, dedup, tenant resolve, enqueue
L2  Wix Adapter          adapters/wix-adapter.js  Normalize Wix event payload → standard job format
L3  Standard Adapter     core/standard-adapter.js Grant/revoke orchestration, member_role_assignments writes
L4  Core Engine          core/grant-revoke.js     Business logic: plan resolve, API key resolve, status updates
L5  Hardware Adapter     adapters/hardware-adapter.js Abstract interface: createUser(), assignGroup(), removeGroup()
L6  Kisi/Seam Connector  connectors/kisi.js, connectors/seam.js  Platform API calls
L7  Hardware API         Kisi Cloud / Seam Cloud  Physical access control
```

All hardware operations go through L5 (HardwareAdapter). No code outside the adapter layer calls Kisi or Seam directly.

---

## Key Design Principles

1. **Event-driven first.** Wix webhooks are the primary trigger. No polling. The system acts immediately on events.
2. **Hardware API called only for delta.** `member_role_assignments` is the comparison layer. Hardware is never called to audit state — only to provision or revoke.
3. **Data minimization (DR-001).** Primary member PII (name, email) is fetched from Wix on demand, not stored. Only sub-members store PII directly (different data model by design — S-07).
4. **Hardware abstraction.** All hardware operations go through the adapter interface. Kisi and Seam are interchangeable at the connector layer.
5. **Platform-agnostic column names (DR-035).** No Wix-specific or Kisi-specific column names in schema. Enables future platform additions without migration.
6. **Fault-tolerant activity tracking.** `client_activity_summary` UPSERT failures never block the grant/revoke path.
7. **Pending is not failed.** `pending_hardware` is a configuration gap state, not a processing failure. It resolves via operator action, not retry schedule.

---

## Known Gaps Relevant to Build

| ID | Description | Blocking? |
|----|-------------|-----------|
| ~~U-09~~ | ~~"Kisi app" hardcoded in onboard.ejs, sync-status.ejs, API key form~~ | **CLOSED 2026-04-10** — all platform-specific copy replaced |
| SCREEN-G-02 | API key form label not platform-agnostic | Pre-HOG |
| ~~WIRE-G-01~~ | ~~pending_hardware auto-resolution trigger not yet built~~ | **CLOSED 2026-04-10** — `retryPendingHardwareMembers(clientId, planId)` called on plan mapping PATCH; scoped to matching `pending_plan_id` |
| FUNNEL-G-15 | Setup check edge case: API key without locations goes to dashboard | Post-HOG |
| SCREEN-G-08 | HMAC spike alerts are email-only, no in-app surface | Post-HOG |
| S-14 | webhook_log retention policy not defined | Pre-scale |
| S-10 | adapter_admin_log is dual-purpose — split post-V1 | Post-V1 |
| S-08 | Legacy role_assignment_id on member_access_state needs retirement DR | Post-V1 |
| Member name gap | Members API returns platform_member_id only — no name fetch from Wix | Operator UX gap |

---

*QUILL — Step 1 of 9 complete. Next: DECISION_REGISTER.md.*
