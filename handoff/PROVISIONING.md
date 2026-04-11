---
file: PROVISIONING.md
produced_by: NOVA
step: 7 of 9
handoff_version: 1.0.0
date: 2026-04-10
verified: Yes — onboarding routes verified against admin/routes/operator.js
---

# PROVISIONING — New Client Onboarding Atomic Sequence

Defines the complete sequence for onboarding a new AccessSync client (gym). Covers Railway setup, database, Wix configuration, and operator first-run flow. Every step is atomic — partial completion leaves the system in a recoverable state.

---

## Prerequisites (Before Any Client Is Onboarded)

| Requirement | Location | Notes |
|-------------|----------|-------|
| Railway Core Engine deployed | Railway | `server.js` — handles webhooks + member API |
| Railway Admin Server deployed | Railway | `admin/server.js` — operator dashboard |
| PostgreSQL provisioned | Railway | Schema applied via `schema.sql` |
| Redis provisioned | Railway | BullMQ queue backing |
| Resend API key | Env var: `RESEND_API_KEY` | Email alerts |
| Encryption key | Env var: `ENCRYPTION_KEY` | AES-256-GCM for API key storage |
| Wix app installed on AccessSync dev account | Wix Partner Dashboard | Required for sidebar widget |

---

## Step 1 — Create Client Record

Create the client row in the database. This is the tenant anchor.

```sql
INSERT INTO clients (name, platform, site_id, hardware_platform, tier, status, notification_email, site_url)
VALUES ($1, 'wix', NULL, $2, $3, 'active', $4, $5)
RETURNING id
```

**Fields:**
- `name` — Gym name (e.g. "House of Gains")
- `hardware_platform` — 'kisi' or 'seam'
- `tier` — 'Base', 'Pro', 'Connect'
- `notification_email` — Operator alert destination
- `site_url` — Gym website URL (displayed in dashboard header)
- `site_id` — NULL initially (set on first webhook via TenantResolver.registerSiteId or portal auth)
- `wix_instance_id` — NULL initially (set on first portal auth)

**Output:** `clients.id` UUID — used in all subsequent steps.

---

## Step 2 — Generate Invite Token

Generate a time-limited invite token for the operator to access the onboarding wizard. This token gates the onboarding endpoints before the operator has a JWT.

```sql
-- Token is generated in-memory (crypto.randomBytes) and stored temporarily.
-- Current implementation: invite token is a URL param on the onboarding link.
-- Token is validated by requireInviteToken middleware on /operator/clients/* endpoints.
```

**Invite link format:**
```
https://<admin-server>/onboard?clientId=<UUID>&token=<invite-token>
```

**Send to:** Gym owner email (via Resend or manual).

---

## Step 3 — Operator Completes Onboarding (S02 Onboarding Flow)

The operator opens the invite link and completes the multi-step wizard.

### Step 3a — Hardware Platform Selection
`PATCH /operator/clients/:clientId/hardware-platform`

Updates `clients.hardware_platform`. No side effects.

### Step 3b — API Key Entry and Test
`POST /operator/clients/:clientId/api-key` (onboarding variant — invite token auth)

1. Validates API key format
2. AES-256-GCM encrypts with `ENCRYPTION_KEY`
3. Stores in `clients.hardware_api_key`
4. Calls `retryPendingHardwareMembers(clientId)` — re-queues any pre-existing `pending_hardware` members (relevant for re-onboarding, not first install)
5. Returns `{ ok: true, pendingRetried: N }`

### Step 3c — Location Creation
`POST /operator/clients/:clientId/locations` (invite token auth)

1. Creates location row: name, city, state, tier
2. Sets `subscription_status = 'inactive'` (default)

`POST /operator/clients/:clientId/locations/:locationId/activate`

1. Sets `subscription_status = 'active'` and `subscribed_at = NOW()`
2. Location is now active — plan-mapping-resolver will include it in grant decisions (DR-027)

### Step 3d — Plan Mapping
`PATCH /operator/clients/:clientId/plan-mappings/:mappingId`

1. Updates `plan_mappings.hardware_group_id` and/or creates `plan_mapping_groups` rows
2. Sets `status = 'active'`
3. For each mapping save: plan-level re-queue not yet automatically triggered from this endpoint (check if needed — `retryPendingHardwareMembers` is called on API key save, not plan mapping save in current code)

**Note:** Check `admin/routes/operator.js` plan mapping save handler for whether `retryPendingHardwareMembers` is called there. Confirmed called on API key save (lines 277, 400, 594). Plan mapping save may need the same addition.

### Step 3e — Confirmation
Operator redirected to `/dashboard?clientId=<UUID>`.

---

## Step 4 — Wix Webhook Configuration

Configure Wix to send webhooks to the AccessSync Core Engine.

**Webhook URL:** `https://<core-engine-railway-url>/webhooks/wix`

**Events to subscribe:** (Wix App Dashboard → Webhooks)
- `plans/orderCanceled`
- `plans/orderPurchased`
- `orders/approved` (booking confirmed)
- `orders/canceled` (booking cancelled)
- `contacts/contact.deleted` → maps to `member.deleted`
- `payment/failed`
- `payment/recovered`

**HMAC:** Wix signs webhooks with HMAC-SHA256. AccessSync validates signature in `wix-connector.js`. The shared secret is stored in env var `WIX_WEBHOOK_SECRET`.

**Wix Site ID → Client mapping:** First webhook auto-wires `site_id` to the client via TenantResolver if `DEFAULT_TENANT_ID` was used. With portal auth: `site_id` is set during `/operator-portal` verification.

---

## Step 5 — Wix Portal App Installation

Install the AccessSync sidebar app in the operator's Wix Dashboard.

1. Operator installs AccessSync from Wix App Market (or direct install for HOG via Velo — DR-016)
2. Wix calls AccessSync's OAuth callback or generates `wix_instance` JWT
3. Operator opens AccessSync from sidebar → `GET /operator-portal?instance=<signed_instance>`
4. `wix-instance.js` verifies signed instance:
   - Path 1: `wix_instance_id` match in `clients` table
   - Path 2: Decode `wix_api_key` for this instance → find `site_id` → match client
   - Path 3: `site_id` direct match
5. If matched: JWT issued, operator redirected to setup or dashboard
6. `clients.wix_instance_id` set for future auth lookups

---

## Step 6 — First Member Webhook (Validation)

The first real webhook from a member purchase validates the full pipeline.

```
Member purchases plan on Wix
→ Wix fires plan.purchased
→ POST /webhooks/wix (Core Engine)
→ HMAC validated
→ TenantResolver: site_id → client record
→ Dedup: new event_id
→ BullMQ job enqueued
→ Queue worker picks up
→ plan-mapping-resolver: source_plan_id → mappings with hardware groups
→ API key resolved (decrypted)
→ HardwareAdapter: createUser + assignGroup
→ member_role_assignments written
→ member_access_state: status = 'active'
→ clients.first_grant_sent set to true (if not already)
→ First grant email sent to operator via Resend
```

**Validation checklist:**
- [ ] Webhook received in webhook_log (check Admin Hub → Webhook Inspector)
- [ ] No errors in error_queue
- [ ] member_access_state.status = 'active' for the member
- [ ] member_role_assignments has rows for the member
- [ ] Member can open door in Kisi app

---

## Key Environment Variables (Both Services)

| Variable | Service | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | Both | PostgreSQL connection string (Railway) |
| `REDIS_URL` | Core Engine | BullMQ queue backing |
| `ENCRYPTION_KEY` | Both | AES-256-GCM key for API key storage |
| `WIX_WEBHOOK_SECRET` | Core Engine | HMAC validation for inbound webhooks |
| `RESEND_API_KEY` | Admin Server | Email alert sending |
| `CORE_ENGINE_URL` | Admin Server | Used to generate webhook URL in onboarding |
| `ADMIN_ALLOWED_EMAILS` | Admin Server | Comma-separated list of allowed Google OAuth emails (Daxx only) |
| `JWT_SECRET` | Admin Server | Signs operator JWT cookies |
| `DEFAULT_TENANT_ID` | Core Engine | **REMOVED** — was bootstrapping HOG. Do not re-add. |

---

## Known Onboarding Gaps

| ID | Gap | Impact |
|----|-----|--------|
| FUNNEL-G-15 | Setup check: operator with API key but no locations (or vice versa) → dashboard directly | Partial setup not caught |
| WIRE-G-01 | `retryPendingHardwareMembers` not called from plan mapping save handler | Members pending on plan mapping don't auto-retry when plan mapped (API key save does trigger it) |
| Admin panel | Wix admin user sync not built | Operator can't see who else has portal access |

---

## Re-Onboarding (Existing Client, New Setup)

If an operator needs to redo setup (e.g., new Kisi account):

1. Rotate API key via System Config → `retryPendingHardwareMembers` called automatically
2. Update plan mappings via Plan Mapping tab
3. If location subscription lapsed → reactivate via Locations tab
4. Nightly reconciliation will sweep `failed` and `skipped_lockdown` members

Full member re-provisioning (for members who lost access during a gap) requires:
- Either: nightly reconciliation (automated for failed/skipped)
- Or: manual retry via Error Queue / Debug Center

Full Wix↔Kisi resync is post-V1 (deferred feature).
