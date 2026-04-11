---
file: HANDOFF_BRIEF.md
produced_by: QUILL
step: 8 of 9
handoff_version: 1.0.0
date: 2026-04-10
status: PENDING SAGE GATE
---

# HANDOFF BRIEF — AccessSync v1.0.0

**To:** Any Claude Code session working on AccessSync  
**From:** QUILL (BOT Team)  
**Date:** 2026-04-10  
**Handoff version:** 1.0.0

---

## What You're Working On

AccessSync is a multi-tenant SaaS middleware that connects Wix memberships to Kisi/Seam physical access control hardware. When a gym member buys a plan on Wix, AccessSync automatically grants them door access in Kisi or Seam. When they cancel, access is revoked.

**Stack:** Node.js / PostgreSQL / BullMQ (Redis) / Railway. Two servers: Core Engine (webhook receiver + member API) and Admin Server (operator dashboard).

**First client:** House of Gains (HOG), gym owner Chad. Kisi hardware. Wix memberships. Single location. HOG launch is the current milestone gate.

---

## Read This First

Before writing any code, read these files in order:

| Priority | File | What It Contains |
|----------|------|-----------------|
| 1 | `handoff/APP_CONTEXT.md` | System overview, data model, critical rules |
| 2 | `handoff/DECISION_REGISTER.md` | All 35 architectural decisions — do not violate these |
| 3 | `handoff/CIRCUIT_REVIEW.md` | Pre-build blockers and architecture assessment |
| 4 | `handoff/QUERY_PATTERNS.md` | Verified query patterns — use these, don't invent new ones |
| 5 | `handoff/PROVISIONING.md` | New client onboarding atomic sequence |
| 6 | `handoff/flow/NAV_MANIFEST.json` | All screens and navigation |
| 7 | `handoff/flow/FLOW_REPORT.md` | All user flows, edge cases, dead ends |
| 8 | `handoff/iris/IRIS_INDEX.md` | Screen map index — link to per-screen IRIS files |

---

## Current Build Status

**Sprint 5 complete.** 32/32 tests passing. Deployed on Railway.

**Pre-HOG items remaining:**

| ID | Item | Status | File(s) to Touch |
|----|------|--------|-----------------|
| RISK-01 | Add `member_access_sources` table (DR-034 — NOT IN SCHEMA) | **OPEN** | `schema.sql` (new migration), `core/standard-adapter.js` (grant/revoke path) |
| U-09 | Remove "Kisi app" hardcoded strings | **CLOSED 2026-04-10** | `admin/views/pages/sync-status.ejs` updated. `onboard.ejs` updated. All platform-specific copy removed. |
| Minor (WIRE-G-01) | Add `retryPendingHardwareMembers` to plan mapping save handler | **CLOSED 2026-04-10** | `admin/routes/operator.js` PATCH `/:clientId/plan-mappings/:mappingId` — scoped re-queue added with `pending_plan_id` matching. |

**Gates:**
- RISK-01 must be resolved before modifying the grant/revoke path (core/standard-adapter.js, core/grant-revoke.js)
- All changes need tests to stay at 32/32 green

---

## What NOT to Touch Without a DR

These areas have explicit decisions locked in the DECISION_REGISTER. Do not modify their behavior without flagging to KEEPER:

| Area | DR | Rule |
|------|----|------|
| `member_role_assignments` writes | DR-023 | Standard Adapter exclusively owns writes. No other file writes to this table. |
| `member_identity` writes | DR-023 | Same — Standard Adapter only. |
| Hardware API calls (direct Kisi/Seam) | DR-022 | Must go through L5 HardwareAdapter. No code outside adapters calls Kisi/Seam directly. |
| Column names (platform_member_id, source_plan_id, hardware_api_key) | DR-035 | Platform-agnostic names. Never add wix_*, kisi_* column names. |
| Sub-member code (multi-member.ejs) | DR-029–032 | Fully gated. Do not activate without HOG confirmation that family plans are live. |

---

## Architecture in One Paragraph

Wix sends a webhook → HMAC-validated → deduplicated → tenant resolved → job enqueued to BullMQ. Queue worker resolves member identity, resolves plan→door mapping, resolves API key, calls Kisi or Seam to create user and assign group, writes the role assignment ID to `member_role_assignments`, and sets `member_access_state.status = 'active'`. On cancel: same webhook path, instead removes role assignments from `member_role_assignments` and calls Kisi DELETE. The `member_role_assignments` table is the living access record — it is the comparison layer for all sync operations. Hardware is never called to audit current state, only to act on delta.

---

## Two Servers — Critical Routing Rule

| Server | Entry point | What it handles |
|--------|-------------|-----------------|
| Core Engine (`server.js`) | Railway public URL | Webhooks from Wix, member status API. 3 endpoints only. |
| Admin Server (`admin/server.js`) | Separate Railway service | Operator portal (iframe), operator API, Admin Hub (Daxx). |

Do not add webhook-handling logic to the Admin Server. Do not add operator UI routes to the Core Engine.

---

## Key Files Quick Reference

| File | Purpose |
|------|---------|
| `core/standard-adapter.js` | Owns all state writes — member_identity, member_access_state, member_role_assignments |
| `core/grant-revoke.js` | Pure grant/revoke hardware logic |
| `core/plan-mapping-resolver.js` | Wix plan → hardware groups, API key resolution |
| `core/tenant-resolver.js` | site_id → client_id lookup (5min cache) |
| `core/wix-connector.js` | HMAC validation, dedup, enqueue |
| `core/reconciliation.js` | Nightly sweep: failed + skipped_lockdown + in_flight timeout |
| `core/hmac-monitor.js` | HMAC failure spike detection → Resend alert |
| `core/location-lapse.js` | Subscription lapse → suspend all location members |
| `core/member-sync-api.js` | `GET /member/access-status` — member portal API |
| `admin/routes/operator.js` | All operator API endpoints (~40 routes, 1300+ lines) |
| `admin/routes/portal.js` | `/operator-portal` — Wix sidebar entry, JWT issuance, setup check |
| `adapters/hardware-adapter.js` | L5 abstraction: createUser, assignRole, removeRole, suspendAccess |
| `adapters/kisi/kisi-adapter.js` | Kisi API connector (L6) — shim at `adapters/kisi-adapter.js` |
| `adapters/seam/seam-adapter.js` | Seam API connector (L6) — shim at `adapters/seam-adapter.js` |
| `db.js` | PostgreSQL pool — shared across all files |
| `schema.sql` | Authoritative schema (folded migrations) |

---

## Tests

Run before and after every change:
```bash
npm test
```

Target: 32/32 green. Do not ship with failing tests.

Test infrastructure is in `test/`. Playwright smoke tests in `test-screens.js`. Integration tests mock nothing — they hit real test DB patterns.

---

## Open Questions for Daxx Before HOG Launch

1. **DR-034 / member_access_sources:** HOG members may have only single plans, so the unsafe revoke may not trigger. But the schema gap is real. Confirm: build the table now (safe, one migration), or defer and accept the known risk?

2. **Kisi API test (G-08):** Need to test against Chad's HOG Kisi org — duplicate POST behavior and valid_until expiry. Can this be tested before HOG launch?

3. **Member name display:** Operator Members tab shows mock data / platform_member_id in production. Is this acceptable for HOG, or does Chad need to see real member names?

~~4. **Plan mapping save re-queue:** Should `retryPendingHardwareMembers` be called on plan mapping save too (not just API key save)?~~ **RESOLVED 2026-04-10** — scoped `retryPendingHardwareMembers(clientId, planId)` added to plan mapping PATCH handler. Members parked with matching `pending_plan_id` are re-queued automatically when the mapping is saved.

---

*QUILL — Step 8 of 9 complete. KEEPER updated 2026-04-10: U-09 closed, WIRE-G-01 closed, Q4 resolved, file paths corrected. Pending: Step 9 — KEEPER audit + SAGE gate.*
