---
file: FLOW_REPORT.md
produced_by: NOVA + ORION
step: 4 of 9
handoff_version: 1.0.0
date: 2026-04-10
---

# FLOW REPORT — AccessSync

Complete user flow documentation for all actor types. Covers happy paths, edge cases, error paths, and recovery flows.

---

## Actor Types

| Actor | Entry Point | Server | Auth |
|-------|-------------|--------|------|
| Platform Admin (Daxx) | Browser → /admin/login | Admin Server | Google OAuth → admin JWT |
| Operator (gym owner) | Wix Dashboard sidebar → /operator-portal | Admin Server | Wix signed instance → operator JWT (8h, sameSite: none) |
| Gym Member | Wix purchase confirmation → /sync-status | Core Engine | URL params or Wix member JWT |
| Wix Platform | Webhook POST → /webhooks/wix | Core Engine | HMAC-SHA256 |

---

## Flow 1 — Operator First-Run Setup

**Trigger:** Gym owner opens AccessSync in Wix Dashboard sidebar for the first time.

```
Step 1: Wix Dashboard sidebar widget loads iframe
Step 2: GET /operator-portal?instance=<wix_signed_instance>
Step 3: wix-instance.js verifies signed instance (three-path lookup):
        → wix_instance_id match → client found
        → decode wix_api_key → site_id match → client found
        → site_id direct match → client found
        → none: 401
Step 4: Operator JWT issued (8h, sameSite: none)
Step 5: Setup check:
        clients.hardware_api_key IS NULL AND locations count = 0
        → TRUE: redirect to /operator-portal/setup → S01 Portal Setup Welcome
        → FALSE: redirect to /dashboard?clientId=X → S03 Dashboard
Step 6 (first-run): S01 — operator clicks "Start Setup"
Step 7: S02 Onboarding Flow
        7a. Select hardware platform (Kisi / Seam)
        7b. Enter API key → Test Connection → PASS
        7c. Create location (name, city, state, tier)
        7d. Map Wix plans to hardware groups
        7e. Confirmation screen
Step 8: Redirect to S03 Dashboard
```

**Edge case — FUNNEL-G-15:** If operator has an API key but no locations, or locations but no API key, setup check evaluates to FALSE and they bypass setup. No guard exists.

---

## Flow 2 — Operator Returning Session

```
Step 1: Wix Dashboard sidebar opens iframe
Step 2: GET /operator-portal?instance=X
Step 3: Instance verified → client resolved
Step 4: Operator JWT issued
Step 5: Setup check → FALSE (has config)
Step 6: Redirect to /dashboard?clientId=X → S03
```

**Session expiry:** `apiFetch()` catches 401 → operator-nav.js triggers session expired modal → operator prompted to re-open from Wix Dashboard.

---

## Flow 3 — Member Purchase and Access Provisioning (Happy Path)

**Trigger:** Gym member buys a pricing plan on the gym's Wix site.

```
Step 1: Member completes Wix purchase
Step 2: Wix fires plan.purchased webhook → POST /webhooks/wix
Step 3: wix-connector.js:
        → HMAC-SHA256 validated
        → event_id dedup check (processed_event_ids)
        → site_id → client record resolved
        → event marked processed (written to processed_event_ids)
        → job enqueued to BullMQ
Step 4: Queue worker (concurrency 20) picks up job:
        → member_identity upserted (client_id, platform_member_id, hardware_platform)
        → plan_mappings resolved:
            source_plan_id match found, hardware_group_id set → [mappings] (proceed)
Step 5: API key resolved:
        locations.hardware_api_key → clients.hardware_api_key
        → Key found → decryptApiKey() → proceed
Step 6: Hardware adapter (KisiAdapter or SeamAdapter):
        → createUser(email, name) via Wix API fetch on-demand
        → assignGroup(userId, groupId) per mapping
Step 7: member_role_assignments rows written (one per group)
Step 8: member_access_state: status = 'active', provisioned_at = now
Step 9: member_access_log: event_type = 'provisioned'
Step 10: client_activity_summary: grants_completed++ (fault-tolerant)
Step 11: first_grant_sent check → if false: send first-grant email via Resend
Step 12: Member opens /sync-status?memberId=X&clientId=Y
         → polls /member/access-status every 3s
         → status = 'active' → "You're all set!" rendered
```

---

## Flow 4 — Member Cancels (Revoke Path)

**Trigger:** Member cancels plan on Wix.

```
Step 1: Wix fires plan.cancelled webhook
Step 2-3: HMAC, dedup, tenant resolve (same as Flow 3)
Step 4: Queue worker:
        → member_identity resolved (existing record)
        → revoke path: completeRevoke()
Step 5: Hardware adapter:
        → removeGroup() for each role_assignment_id in member_role_assignments
Step 6: member_role_assignments: DELETE all rows for member (atomic)
Step 7: member_access_state: status = 'revoked'
Step 8: member_access_log: event_type = 'revoked'
```

**Multi-source rule (DR-034 — NOT YET BUILT):** If member has another active plan granting the same group, Kisi DELETE should be skipped. This check requires `member_access_sources` table. Without it, revoke will remove access even if another plan justifies it.

---

## Flow 5 — Payment Failure (Suspend Path)

**Trigger:** Wix fires payment.failed webhook.

```
Step 1-3: HMAC, dedup, tenant resolve
Step 4: Queue worker:
        → member_access_state: status = 'disabled'
        → member_role_assignments: RETAINED (not deleted)
        → Kisi: access_enabled = false (user-level suspension)
Step 5: member_access_log: event_type = 'disabled'
```

**Recovery (payment.recovered):**
```
Step 1-3: HMAC, dedup, tenant resolve
Step 4: Kisi: access_enabled = true
Step 5: member_access_state: status = 'active'
Step 6: member_access_log: event_type = 'restored'
```

**Note:** `access_enabled = false` suspends ALL of the member's access across ALL groups (Kisi constraint — no per-group suspension). DR-034 notes this explicitly.

---

## Flow 6 — Pending Hardware (Park and Resolve)

**Trigger:** Member purchases before operator setup is complete (no API key or no plan mapping).

**Park:**
```
Step 1-3: HMAC, dedup, tenant resolve
Step 4: Queue worker:
        → Plan mapping resolved: no mapping found (source_plan_id not in plan_mappings)
          OR API key resolved: null (no key at client or location level)
        → member_access_state: status = 'pending_hardware'
        → member_access_state.pending_plan_id = source_plan_id stored
```

**Resolve — WIRE-G-01 (NOT YET BUILT):**
```
Trigger: Operator saves API key (PATCH /operator/:clientId/api-key)
      OR Operator saves plan mapping (PATCH /operator/:clientId/plan-mappings/:id)

Action required:
  → Query: SELECT * FROM member_access_state
           WHERE client_id = $clientId AND status = 'pending_hardware'
  → For each pending member: re-queue through standard grant flow
  → Grant flow runs normally now that config is complete
```

**Current state:** `pending_hardware` members are parked indefinitely until this trigger is built. Operator has no way to resolve them except manually via the Debug Center.

---

## Flow 7 — Nightly Reconciliation

**Trigger:** Scheduled cron (nightly).

```
Step 1: Query member_access_state:
        → status = 'failed' → retry grant flow
        → status = 'skipped_lockdown' → retry grant flow
        → status = 'in_flight' AND updated_at < NOW() - 10min → reset to 'pending_sync', retry
Step 2: NOT swept:
        → 'pending_hardware' (config gap — resolves by operator action only)
        → 'disabled' (awaits payment.recovered webhook)
Step 3: For each retry: standard grant flow re-runs
Step 4: client_activity_summary updated
```

---

## Flow 8 — Location Subscription Lapse

**Trigger:** `locations.subscription_status` transitions to 'lapsed'.

```
Step 1: location-lapse.js called
Step 2: All member_access_state for this location → status = 'disabled'
Step 3: For each member: Kisi access_enabled = false
Step 4: member_access_log: event_type = 'disabled' (reason: subscription_lapsed)
```

**Restore:**
```
Subscription restored → subscription_status = 'active'
Operator reactivates location (button in S05)
→ Re-provisioning triggered for eligible members
```

---

## Flow 9 — Operator Error Triage

**Trigger:** Operator sees failed members in S09 Sync Status.

```
Step 1: Operator opens S09 Sync Status → error card visible
Step 2: Option A — Retry:
        → POST /operator/:clientId/errors/:errorId/retry
        → Job re-queued to BullMQ
        → Error card shows "Retrying"
        → If success: card removed, member status = active
        → If fail again: card returns with updated error
Step 3: Option B — Dismiss:
        → PATCH /operator/:clientId/errors/:errorId/dismiss
        → Dismiss note optional
        → Card removed, error_queue.status = 'resolved'
```

---

## Flow 10 — HMAC Spike Alert

**Trigger:** 3+ HMAC failures within 300 seconds from same client.

```
Step 1: wix-connector.js HMAC validation fails
Step 2: hmac-monitor.js records failure in Redis (keyed per client per window)
Step 3: If count >= 3 within 300s:
        → Resend email sent to operator notification_email
        → Redis key expires (window resets)
Step 4: No in-app alert surface (SCREEN-G-08 — post-HOG gap)
```

---

## Known Dead Ends and Gaps

| ID | Flow | Gap |
|----|------|-----|
| WIRE-G-01 | Flows 4 and 6 | pending_hardware auto-resolution trigger not built |
| DR-034 | Flow 4 (revoke) | member_access_sources not built — unsafe multi-source revoke |
| FUNNEL-G-15 | Flow 1 | Setup check edge case — partial config bypasses setup |
| SCREEN-G-08 | Flow 10 | HMAC spike alerts email-only, no in-app surface |
| FUNNEL-G-07 | Flow 6 | Operator sees pending_hardware count but has no action path in UI |
| U-09 | Flows 1, 3 | "Kisi app" hardcoded in onboard.ejs and sync-status.ejs |
