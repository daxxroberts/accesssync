# CLAUDE.md — AccessSync Core Engine
**Version:** 4.0 | **Updated:** 2026-04-02 | **Author:** KEEPER (Business Operating Team)

---

## What This Is

AccessSync is a Wix App Market SaaS product that automates physical space access control for gym and fitness operators. When a member purchases a Wix pricing plan, AccessSync automatically provisions their access credentials in the hardware system (Kisi or Seam). No manual operator action required.

**First client:** House of Gains (Chad) — Kisi Pro tier, $199/mo/location.

---

## Deployment Environment

**Railway only.** All services, databases, and cron jobs run on Railway. Never:
- Start a local dev server
- Create a `.env` file for local use
- Suggest `localhost` testing
- Run Railway CLI commands to proxy local connections

All database migrations run via Railway's Postgres public URL. When running SQL, use `railway variables` to get `DATABASE_PUBLIC_URL`, then `psql` against that URL directly.

---

## Repository & Path Rules

- **Repo root:** `C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync GitHub\accesssync`
- **Vault root:** `C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync`
- Always confirm `git rev-parse --git-dir` succeeds before any git command.
- Never commit from a non-repo directory.

---

## UI Pages

When asked about a UI page or to view/open one:
1. Read the existing file first.
2. Surface the file path and a `file://` link the user can click to open it in a browser.
3. Do NOT recreate or rewrite the page unless explicitly asked to make changes.

---

## Repository State

**All 4 project-plan sprints complete. Business-risk-aware test framework live (Concept #6): 32 tests across P1/P2/P3 tiers, custom Jest reporter + sequencer. `npm run test:deploy` gives DEPLOY SAFE / DO NOT DEPLOY verdict. End-to-end provisioning pipeline working. Member-facing sync status page live. Operator console wired to live data. Onboarding hardened with invite token auth, end-to-end validation step, and location auto-activation. Pending: HOG site_id + Kisi key entry in Railway DB, business gates G-01/02/03/08/09.**

**Current status as of 2026-03-31:**
- `schema.sql` — DR-018 through DR-026 applied. 13 tables total. Added: `member_role_assignments` (DR-026), `access_type` column on `plan_mappings` (DR-026). ✅ OB-18 closed — both Railway migrations applied.
- `db.js` — ✅ Built. pg pool, query helper, `getClient()`, `healthCheck()`, `pool` exported.
- `adapters/wix/wix-connector.js` — ✅ Layer 1. HTTP handler, HMAC verification (uses `req.rawBody`). Reads `X-AccessSync-Client-Id` header → calls `tenantResolver.registerSiteId()` for self-registration. Calls wix-adapter.parseEvent(). On HMAC rejection: calls `hmacMonitor.recordFailure()` (Sprint 5.1).
- `adapters/wix/wix-adapter.js` — ✅ Layer 2. Wix payload parsing only. parseEvent() → standard event object. Zero dependencies. Multi-path resolution for memberId + planId across Pricing Plans, Bookings, and Members event structures (P6 fix).
- `adapters/standard-adapter.js` — ✅ Layer 3. Owns member_identity, member_access_state, in_flight lock (DR-023). resolveAndLock(), resolveIdentity(), completeGrant(), completeRevoke(), releaseLock(). Writes client_activity_summary (DR-024). `_maybeFireFirstGrantEmail()` — atomic first-grant welcome email per client (Sprint 5.5).
- `adapters/hardware-adapter.js` — ✅ Layer 5. Hardware platform router. Delegates to kisi/seam by hardwarePlatform string (DR-022). `assignRole()` passes `options.validUntil` through (Gap 6). `getRateLimit()` returns req/sec per platform (informational).
- `adapters/kisi/kisi-adapter.js` — ✅ Layer 6. Kisi business methods. Calls kisi-connector. `getGroups(apiKey)` — `GET /groups` for plan mapping dropdown (OB-42). `assignRole()` supports `options.validUntil` → `valid_until` (Gap 6). `getLocks()` returns normalized `{ id, name, locked: boolean }` shape (DR-035 Fix 4).
- `adapters/kisi/kisi-connector.js` — ✅ Layer 7. Kisi HTTP client, rate limiting, auth headers.
- `adapters/seam/seam-adapter.js` — Stub. Layer 6 equivalent. Post-V1.
- `adapters/seam/seam-connector.js` — Stub. Layer 7 equivalent. Post-V1.
- `adapters/wix-adapter.js` — Shim → `./wix/wix-connector` (DR-022 backward compat).
- `adapters/kisi-adapter.js` — Shim → `./kisi/kisi-adapter` (DR-022 backward compat).
- `adapters/seam-adapter.js` — Shim → `./seam/seam-adapter` (DR-022 backward compat).
- `server.js` — ✅ Fully implemented. Imports `adapters/wix/wix-connector` (DR-022). DB health check, BullMQ worker boot, SIGTERM graceful shutdown.
- `core/queue-worker.js` — ✅ Built. Layer coordinator. Calls standardAdapter (resolve/lock/complete) around grantRevokeLogic. `payment.recovered` early-exit path (enableAccess only). `UnrecoverableError` for 4xx errors (DR-026). Concurrency: 20 (rate limiting moved to per-adapter connectors — DR-035 Fix 5).
- `core/hmac-monitor.js` — ✅ Built (Sprint 5.1). Redis sliding window HMAC failure counter. 3 failures in 5 min → Resend alert to `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL`. 10-min cooldown key prevents alert storm. Non-blocking — never interrupts webhook flow.
- `core/hardware-health-check.js` — ✅ Built (Sprint 5.2). 6-hourly Railway Cron. Tests each active client's `hardware_api_key` via `getLocks()`. 401 = invalid key, 403 = permissions error, no key = config missing. Sends specific diagnosis email per failure type. Updates `locations.hardware_key_last_verified` + `hardware_key_last_error`.
- `core/tenant-resolver.js` — ✅ Built. `site_id` → `client_id` with 5-min cache. `registerSiteId(clientId, siteId)` — idempotent UPDATE for self-registration. `DEFAULT_TENANT_ID` fallback auto-wires real `site_id` on first webhook.
- `core/webhook-processor.js` — ✅ Built. BullMQ Queue, real DB dedup, tenant resolution, `eventQueue` exported.
- `core/plan-mapping-resolver.js` — ✅ Built. Returns Array of all active mappings (DR-026). `status='active'` filter. Includes `mappingId` + `accessType`.
- `core/grant-revoke.js` — ✅ Built. `processGrant` loops all mappings[], returns `assignments[]`. `processRevoke` loops all `roleAssignmentIds[]`. Identity/lock/state owned by Standard Adapter (DR-023).
- `core/retry-engine.js` — ✅ Built. `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/reconciliation.js` — ✅ Built. Calls hardwareAdapter.getLocks() (DR-022). Stale lock cleanup, failed job re-queue, operator digest.
- `core/member-sync-api.js` — ✅ Built. RS256 JWT verification live (OB-08 closed). Returns enriched access array: plan names, door names, location info (OB-06 enrichment).
- `core/location-lapse.js` — ✅ Built. OB-20. suspendLocationMembers() — suspends all active members at a location when subscription lapses. DR-027 billing integrity.
- `admin/server.js` — ✅ Built. Separate Express app. Crash-isolated from Core Engine. EJS view engine (`admin/views/`). 6 operator page routes (`/dashboard`, `/members`, `/plan-mapping`, `/access`, `/locations`, `/admin-panel`). Passes `activeTab` to subnav partial.
- `admin/middleware/auth.js` — ✅ Built. JWT httpOnly cookie.
- `admin/routes/auth.js` — ✅ Built. Google OAuth. Auth-001 closed.
- `admin/routes/errors.js` — ✅ Built. Full Error Queue CRUD + BullMQ retry.
- `admin/routes/members.js` — ✅ Built. Debug Center — search (email detection → Wix Members API resolve → ILIKE fallback), timeline, retry. OB-13 closed.
- `admin/routes/webhooks.js` — ✅ Built. Webhook Inspector — recent + detail.
- `admin/routes/queue.js` — ✅ Built. Queue Monitor — counts + jobs by state.
- `admin/routes/clients.js` — ✅ Built. Clients panel — GET / (with member counts), PATCH /:id. POST /:id/api-key, GET /:id/api-key/status, GET /:id/api-key/test (validates stored key against Kisi GET /groups?limit=1). decryptApiKey + kisiConnector imported.
- `admin/public/index.html` — ✅ Built. Dashboard shell — 5 panels, login screen, drawer, modal.
- `admin/public/app.js` — ✅ Built. Full frontend logic — auth, panels, polling, interactions. `testApiKey()` function added. "Test Key" button in client detail drawer (visible when hasKey=true). Calls GET /admin/clients/:id/api-key/test → toast pass/fail.
- `admin/public/styles.css` — ✅ Built. Full CSS v2.0 — brand, layout, components, responsive.
- `admin/views/pages/dashboard.ejs` — ✅ Built. Operator console Overview tab. `loadLiveData()` fetches client overview, locations, errors. Amber "Connect your Kisi API key" banner when key missing (OB-26). Kisi platform chip shows amber "No Key" pill. Served at `/dashboard`.
- `admin/views/pages/members.ejs` — ✅ Built. Operator console Members tab. `loadLiveMembers()` replaces mock array. Filters, detail drawer, pagination. Live data. CSV export respects active filters (Sprint 5.6). Served at `/members`.
- `admin/views/pages/plan-mapping.ejs` — ✅ Built. Operator console Plan Mapping tab. `loadLiveMappings()` fetches real Kisi groups + mappings. Multi-member toggle, group dropdown now live. Inline amber warning when two plans share the same group (Sprint 5.4). Served at `/plan-mapping`.
- `admin/views/pages/access.ejs` — ✅ Built. Operator console Access tab. `loadLiveAccess()` fetches access log + hourly stats. 30-day bar chart, event filters, activity grid. Live data. CSV export respects active event + location filters (Sprint 5.6). Served at `/access`.
- `admin/views/pages/admin-panel.ejs` — ✅ Built. Operator console Admin tab. Wix-synced administrators, role badges, collapsible info section. Served at `/admin-panel`. Mock data.
- `admin/views/pages/locations.ejs` — ✅ Built. Platform Config tab. Org-level key card (set/rotate/test). Alert email card — GET/PUT `notification_email` per client (Sprint 5.3). Location cards with subscription status pill, door/plan/error stats, per-location API key override, suspend/reactivate button (Sprint 5.7). Served at `/locations`.
- `admin/views/partials/head.ejs` — ✅ Built. Shared `<head>` partial — meta, Sora font, operator-styles.css link.
- `admin/views/partials/topbar.ejs` — ✅ Built. Shared topbar — AccessSync logo, sync badge, dark mode toggle.
- `admin/views/partials/subnav.ejs` — ✅ Built. Shared sub-nav container — `data-active` attribute drives tab highlighting via operator-nav.js.
- `admin/public/operator-nav.js` — ✅ Built. Shared JS — sub-nav rendering (6 tabs with routes), dark mode toggle, `showToast()`, `esc()` utility. Loaded on all operator pages.
- `admin/public/operator-styles.css` — ✅ Built. Shared CSS — all operator page styling extracted from individual pages. Sora font, CSS variables, responsive.
- `admin/views/pages/sync-status.ejs` — ✅ Built (OB-46). Member-facing post-purchase sync status page at `/sync-status?memberId=X&clientId=Y`. 4 visual states: syncing (spinner), active (checkmark + access list), error, pending. Polls `/member/access-status` every 3s, max 60 polls. Stale data indicator: amber "Last verified Xs ago" badge after 30s (OI-05). Served by admin/server.js.
- `admin/public/onboard.html` — ✅ Built. Operator-facing multi-step onboarding wizard. Client + location creation deferred to Step 4 via `_provisionClient()` which also calls location activate endpoint. Step 4: Kisi key validated, groups fetched + displayed, owner bypass PIN. Step 5: webhook secret instructions (`accesssync_webhook_secret`), events.js code block, "System Check" panel (`runValidation()` — key exists, key valid, mapping exists, location activated). Reads `?invite=TOKEN`, sends `X-Invite-Token` header (OB-24).
- `admin/routes/operator.js` — ✅ Built. POST /operator/verify-bypass (owner PIN). Signup endpoints protected by `requireInviteToken` middleware (OPERATOR_INVITE_TOKEN env var) + 5 req/IP/min rate limiter (OB-24). POST /clients, /locations, /api-key, /activate. GET /operator/:clientId/kisi-groups (decrypts key, calls getGroups). Access log: GET /operator/:clientId/access-log (paginated, 30-day, filters), GET /operator/:clientId/access-stats (hourly averages). API key management: GET .../api-key/status, GET .../api-key/test, PUT .../api-key. Notification email: GET + PUT .../notification-email (Sprint 5.3). Data: GET members, alerts, errors, mappings, PATCH mappings.
- `docs/what-is-accesssync.html` — ✅ Built. Operator-facing explainer — Wix/AccessSync/Kisi platform boxes, 4-step flow, before/after, pricing tiers. AI_CONTEXT block + breadcrumb + `<link rel="alternate">` added (v4.0).
- `docs/architecture.html` — ✅ Built. 7-layer architecture explainer — layer stack, standard event contract, hardware interface, adapter growth matrix, design principles. AI_CONTEXT block + breadcrumb added (v4.0).
- `docs/endpoints.html` — ✅ Built. All 77 API endpoints across Core Engine and Admin Hub. Color-coded method badges, auth chips, path params. AI_CONTEXT block + breadcrumb added (v4.0).
- `docs/index.html` — ✅ Built (v4.0). KB hub page — nav to all 8 docs, project status, sprint summary, hard gates table, pending Daxx actions. AI_CONTEXT block. `<link rel="alternate">` to llms.txt.
- `docs/data-model.html` — ✅ Built (v4.0). All 14 tables, column-level detail, layer ownership badges, DR chips. Live state (post DR-035). schema.sql discrepancy noted.
- `docs/decision-log.html` — ✅ Built (v4.0). All 35 DRs as lockable cards grouped by domain. `data-locked="true"` + red left border on every card. AI agent protection note in banner.
- `docs/feature-map.html` — ✅ Built (v4.0). 38 features across 5 categories. F038 corrected to live. Changelog row documenting Feature_Map.md discrepancy.
- `docs/operations.html` — ✅ Built (v4.0). All env vars (15), Railway services, migration order with warnings, pre-deploy checklist, hard gates.
- `llms-full.txt` — ✅ Built (v4.0). Full context dump — all 8 doc sections concatenated in dependency order, markup stripped. ~400 lines.
- `migrations/dr-035.sql` — ✅ Written. Platform-agnostic schema renames: `kisi_api_key` → `hardware_api_key` (clients + locations), `wix_plan_id` → `source_plan_id` (plan_mappings). Run on Railway before Sprint 5 code deploy.
- `migrations/sprint-5.sql` — ✅ Written. Sprint 5 columns: `locations.hardware_key_last_verified`, `locations.hardware_key_last_error`, `clients.first_grant_sent`. Run on Railway before Sprint 5 code deploy.

---

## Architecture — 7-Layer Model (DR-022)

```
Layer 1: Wix Connector            adapters/wix/wix-connector.js
  HTTP handler, HMAC-SHA256 verification only. Calls Layer 2.

Layer 2: Wix Adapter Layer        adapters/wix/wix-adapter.js
  Wix payload parsing. parseEvent() → standard event object. Zero dependencies.

Layer 3: Standard Adapter Layer   adapters/standard-adapter.js
  Owns member_identity, member_access_state, in_flight lock (DR-023, DR-011).
  resolveAndLock(), resolveIdentity(), completeGrant(), completeRevoke(), releaseLock().
  Writes client_activity_summary daily UPSERT (DR-024).

Layer 4: Core Engine              core/
  webhook-processor.js    Deduplication, BullMQ enqueue
  queue-worker.js         Layer coordinator — orchestrates Layers 3+4+5
  grant-revoke.js         Pure grant/revoke logic + hardware calls via Layer 5
  plan-mapping-resolver.js  Wix Plan ID → hardware group lookup
  retry-engine.js         Exponential backoff, dead-letter to error_queue
  reconciliation.js       Nightly sweep: failed/skipped jobs, operator digest

Layer 5: Hardware Standard Adapter  adapters/hardware-adapter.js
  Platform router. Delegates to Layer 6 by hardwarePlatform string.
  Interface: findUserByEmail, createUser, assignRole, removeRole,
             suspendAccess, enableAccess, deleteUser, getLocks

Layer 6: Kisi Adapter Layer       adapters/kisi/kisi-adapter.js
  Kisi business methods. Calls Layer 7 for all HTTP.

Layer 7: Kisi Connector           adapters/kisi/kisi-connector.js
  Kisi HTTP client, rate limiting (DR-008), auth headers.
```

**Backward-compat shims (DR-022):** `adapters/wix-adapter.js` → Layer 1. `adapters/kisi-adapter.js` → Layer 6. `adapters/seam-adapter.js` → Layer 6 stub.

**Queue layer:** BullMQ + Railway Redis. `webhook-processor.js` enqueues `'grant'`/`'revoke'` jobs. `queue-worker.js` coordinates: resolveAndLock → resolveIdentity → grantRevokeLogic → completeGrant/Revoke. Dead-letter via `worker.on('failed')` → `retry-engine`.

**Platform adapter contract (DR-021):** All adapters must set `platformMemberId` and `sourcePlatform` in the normalized event object. Core Engine never references platform-specific IDs.

**Hosting:** Railway. Entry: `server.js`. Crons: `node core/reconciliation.js` (nightly), `node core/hardware-health-check.js` (every 6 hours). Health: `GET /health`.

---

## Locked Decisions — Do Not Revisit Without SAGE

| DR | Decision |
|---|---|
| DR-001 | Railway as hosting platform |
| DR-003 | `source_tag = 'accesssync'` on all managed users — distinguishes from manual |
| DR-007 | Managed users (Kisi) — provisioned with `send_emails: false` |
| DR-008 | Rate limit: 5 req/sec with local enforcement in kisi-adapter |
| DR-009 | HMAC-SHA256 signature verification on all Wix webhooks |
| DR-010 | Idempotency via `processed_event_ids` table |
| DR-011 | `in_flight` status lock blocks concurrent grant/revoke for same member |
| DR-012 | BullMQ on Railway Redis for job queue |
| DR-013 | `member_identity` schema: A/B pattern — `hardware_platform` column (not separate tables) |
| DR-014 | Color system: primary #1A1A2E, accent #E94560, neutral #F5F5F5 |
| DR-015 | Mobile-first UI — Wix Blocks, responsive-first |
| DR-016 | HOG Phase 1: Velo direct install, not App Market packaging |
| DR-017 | HOG Phase 1: Regular users (not managed) per Kisi — reversed for HOG only |
| DR-018 | `last_sync_at` added as column to `clients` table. Separate sync_state table deferred to V2. |
| DR-019 | `adapter_admin_log` — `configured_by` + `configured_at` added as nullable columns |
| DR-020 | Operator email via Resend SDK from Core Engine. `clients.notification_email` per-client; `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` env var is HOG Phase 1 fallback (until OB-09 setup wizard). |
| DR-021 | `member_identity.platform_member_id` (was `wix_member_id`) + `source_platform` column. All adapters set `platformMemberId` + `sourcePlatform`. UNIQUE: `(client_id, source_platform, platform_member_id)`. |
| DR-022 | 7-layer architecture — canonical layer model, file paths, shim pattern for backward compat. |
| DR-023 | Standard Adapter Layer (Layer 3) exclusively owns `member_identity` UPSERT, `member_access_state` writes, and in_flight lock acquire/release. Core Engine never writes these tables directly. |
| DR-024 | `client_activity_summary` table — Standard Adapter Layer, daily UPSERT per client. events_received, grants_completed, revokes_completed, errors_count. Fault-tolerant (log but don't throw). |
| DR-025 | `locations` table (id, client_id, name, city, state). `clients`: +site_url, +last_wix_webhook_at. `plan_mappings`: +location_id, +plan_name, +door_name, +status. `error_queue`: +location_id, +plan_name, +door_name. `kisi_org_id` excluded (G-10 open). `error_reason` maps to `plain_message` in API layer — no rename. |
| DR-026 | Multi-door provisioning — `member_role_assignments` table (one row per member per mapping, UNIQUE constraint, idempotent). `plan_mappings.access_type DEFAULT 'group'` for future Seam routing. Resolver returns Array. `payment.recovered` = enableAccess only. `UnrecoverableError` for 4xx hardware errors. Legacy fallback: `member_access_state.role_assignment_id` if `member_role_assignments` empty. Railway migration required (OB-18). |
| DR-027 | Per-location subscription model — one AccessSync subscription per physical location (AccessSync pricing decision, not a Kisi constraint). `locations` gets: `subscription_status` (default `'inactive'`), `tier`, `subscribed_at`, `subscription_id`. `plan-mapping-resolver.js` filters to `subscription_status = 'active'` locations only. Location lapse flow required (OB-20). OB-22: confirm HOG Wix pattern with Chad. |
| DR-028 | Hardware API key storage — `clients.hardware_api_key` (org-level default) + `locations.hardware_api_key` (nullable override for multi-org operators). Lookup: `location.hardware_api_key \|\| client.hardware_api_key`. AES-256-GCM encryption via `core/crypto-utils.js` + `KISI_ENCRYPTION_KEY` env var. `KISI_API_KEY_MOCK` removed (OB-23 closed). |
| DR-035 | Platform-agnostic schema normalization — `clients.kisi_api_key` → `hardware_api_key`, `locations.kisi_api_key` → `hardware_api_key`, `plan_mappings.wix_plan_id` → `source_plan_id`. All code updated. Migration: `migrations/dr-035.sql`. Run on Railway before deploying Sprint 5 code. |

Full decision records are in the vault: `AccessSync/13_Decision_Records/`

---

## Open Build Items — Next Layer

| ID | Item | Blocks |
|---|---|---|
| ~~OB-12~~ | ~~Deploy Admin Hub V1 to Railway~~ — ~~CLOSED 2026-03-27. Live at https://accesssync-admin.up.railway.app~~ | ~~Admin Hub live~~ |
| ~~OB-14~~ | ~~Run 6 pending Railway schema migrations on live Postgres~~ — ~~CLOSED 2026-03-28. All migrations applied.~~ | ~~Admin Hub panels functional~~ |
| ~~OB-18~~ | ~~Railway DB migration — DR-026: `access_type` column + `member_role_assignments` table~~ — ~~CLOSED 2026-03-28. Both migrations applied to live Railway Postgres.~~ | ~~Multi-door grant/revoke in production~~ |
| ~~OB-13~~ | ~~Debug Center email search — CLOSED 2026-04-01. `/search` detects email queries, calls Wix Members API to resolve → platformMemberId, falls back to ILIKE pattern match.~~ | ~~Debug Center full search~~ |
| ~~OB-03-A~~ | ~~CLOSED 2026-03-29 — `wix-connector.js` corrected. Reads `req.body?.instanceId`. PARSE VERIFIED: no `x-wix-site-id` header.~~ | ~~Multi-tenant correctness~~ |
| ~~OB-19~~ | ~~Railway migration — 6 ALTER statements (DR-027 + DR-028 bundled).~~ CLOSED 2026-03-28. All 6 columns applied. | ~~Per-location billing + API key DB storage~~ |
| ~~OB-23~~ | ~~Build `core/crypto-utils.js` (AES-256-GCM).~~ CLOSED 2026-03-28. crypto-utils built, DB lookup wired. | ~~Multi-client onboarding~~ |
| ~~OB-20~~ | ~~CLOSED 2026-03-29 — `core/location-lapse.js`. suspendLocationMembers() suspends active members at a location. Admin routes: POST .../suspend + .../activate.~~ | ~~Billing integrity~~ |
| ~~OB-21~~ | ~~`plan-mapping-resolver.js` — subscription_status filter.~~ CLOSED 2026-03-28 — done as part of OB-23. | ~~Provisioning gate~~ |
| ~~OB-22~~ | ~~Confirm HOG Wix pattern~~ — CLOSED 2026-03-30. Architecture handles both patterns. | ~~HOG Phase 1 correctness~~ |
| ~~OB-05~~ | ~~CLOSED 2026-03-29 — Operator API endpoints added to `admin/routes/operator.js`: GET /:clientId/members, /alerts, /errors. OB-06 Wix widget unblocked.~~ | ~~OB-06, operator visibility~~ |
| ~~OB-06~~ | ~~CLOSED 2026-04-01 — `member-sync-api.js` enriched to return access array with plan names, door names, location info.~~ | ~~Member sync enrichment~~ |
| OB-07 | Confirm Velo owns UI state display logic for `member-sync-api.js` output | Sync screen Velo build |
| ~~OB-08~~ | ~~CLOSED 2026-03-29 — Real RS256 JWT verification in `member-sync-api.js`. JWKS from Wix, cached 1hr. Blocks unauthenticated calls in production.~~ | ~~Phase 5 launch (security gate)~~ |
| OB-09 | FORGE — setup wizard email input → `clients.notification_email` | DR-020 operator notifications |
| G-10 | NOVA reviews Kisi API docs, confirms schema assumptions | Adapter build start |

Full open items list: `AccessSync/open_items.md`

---

## Environment Variables Required

```
DATABASE_URL                  PostgreSQL connection string (Railway)
WIX_WEBHOOK_SECRET            HMAC secret from Wix developer dashboard
KISI_ENCRYPTION_KEY           32-byte hex string for AES-256-GCM API key encryption (DR-028). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PORT                          Set by Railway automatically
NODE_ENV                      development | production
DEFAULT_TENANT_ID             Temporary placeholder — remove when multi-tenant routing is built
RESEND_API_KEY                Resend API key (from resend.com dashboard) — DR-020
RESEND_FROM_EMAIL             Sender address (e.g. alerts@accesssync.io) — DR-020
ACCESSSYNC_OWNER_NOTIFICATION_EMAIL   Platform owner email (Daxx). Receives HMAC spike alerts, reconciliation digests, and client notification fallback when client has no notification_email set. Set once per Railway deployment.

# Admin Hub service (separate Railway service — node admin/server.js)
ADMIN_JWT_SECRET              Random 64-char string — JWT signing secret for admin sessions
GOOGLE_CLIENT_ID              OAuth 2.0 Client ID from Google Cloud Console (public — safe to expose)
ADMIN_ALLOWED_EMAIL           daxxroberts@gmail.com — only this Google account can log in
OWNER_PIN                     Owner PIN to bypass Kisi validation during onboarding — stored in Railway ADMIN service vars
OPERATOR_INVITE_TOKEN         Shared secret for onboarding signup endpoints (OB-24). Generate: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" — operator receives link with ?invite=TOKEN
```

---

## Knowledge Base

**Vault location:**
`C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync`

**Vault version:** 2.0.0
**Start here:** `AccessSync/00_START_HERE.md`
**Open items:** `AccessSync/open_items.md`
**Decisions:** `AccessSync/13_Decision_Records/DECISION_LOG.md`
**Data model:** `AccessSync/04_Data/`
**Integration specs:** `AccessSync/05_Integrations/`

---

## Hard Gates — Nothing Ships Without These Closed

| Gate | Status |
|---|---|
| G-01 Chad signed agreement | Open |
| G-02 LLC formation | Open |
| G-03 Kisi reseller agreement — attorney review | Open |
| G-08 Kisi API access confirmed from Joe | Open |
| G-09 Chad confirmed on Kisi Pro tier | Open |
| G-10 NOVA reviews Kisi API docs, confirms schema assumptions | Open |

G-07 (Michael partnership decision) — **CLOSED 2026-03-24. No partnership. Daxx building solo.**

---

## Team Protocol

This project is managed by the Business Operating Team (BOT). The vault is the single source of truth.

**Governance rules:**
- No architectural decisions without SAGE sign-off
- No vault changes without KEEPER proposal → SAGE review → Daxx approval
- NOVA never designs against memory — always reads repo and vault first
- Silence is not approval. Explicit confirmation required at every gate.
- **Vault-First Question Rule (ALL agents — mandatory):** Before asking Daxx any question, the agent must first search the vault for the answer. If the vault has a clear answer, use it — do not ask. If the vault has a partial answer, state what was found and what specifically remains unresolved. Only ask Daxx questions the vault genuinely cannot answer.
- **Agent idle exit rule:** Any automated/headless agent must exit after 3 consecutive idle polling cycles with no new tasks. Never loop indefinitely. Log a final status summary before exiting.

**Agents with direct build authority:**
- NOVA — Engineering lead. Architecture, build sequencing, all technical decisions.
- PIXEL — Wix frontend (Velo, dashboard widgets)
- FORGE — Operator dashboard (server-side, iframe embed)
- ORION — API integration specialist

**Agents with review/diagnostic authority (no build):**
- SPAN — QA / Test Coverage. Reviews built features end-to-end. Finds test gaps, flags edge cases and failure modes before launch. No build authority — review and flag only.
- Lens — Live Site Monitor. Hits Railway API endpoints, reads response data, diagnoses what's broken vs working. No build authority — diagnostic only.

**Deferred-UI Rule (NOVA + KEEPER — mandatory):**
Any UI element that defers functionality — skip buttons, "I'll do this later" actions, placeholder CTAs, or buttons linking to screens not yet confirmed to exist — MUST have a corresponding OB logged in `open_items.md` before that session closes. The OB must state: (a) what element defers the action, (b) where the completion UI lives or should live, (c) whether that screen currently exists. KEEPER enforces at Session Close. No deferred UI ships without a logged OB.

---

## REX Protocol — Active Session Coordination (MANDATORY)

**REX is the session gatekeeper. No build work begins until REX confirms the vault read is complete.**

### At session start — before any file is touched:

1. **Enforce the KEEPER open gate.** KEEPER must complete the Session Open checklist (below) before NOVA, FORGE, PIXEL, or ORION write a single line of code. REX confirms this explicitly. No exceptions.
2. **Read `open_items.md`.** Identify any hard gates or "blocks build" items relevant to today's work. If any exist, surface them to Daxx before proceeding. Work does not begin on blocked items.
3. **State the session plan.** REX names what is being built today and which spec/schema files cover it. This is the scope contract for the session.

### During the session — ongoing enforcement:

4. **Spec vs code gate.** If any code being written differs from what the relevant spec says, STOP. Either the spec is wrong (KEEPER corrects it first) or the code is wrong. Divergence is never silent.
5. **DR locked mid-session trigger.** When any DR is locked during a session, REX immediately identifies every spec and doc that references the changed field, table, or decision, and adds them to KEEPER's active update list. This does not wait until session close.
6. **Context compression watch.** If a session has grown long (many tool calls, many files read), REX calls a re-read of CLAUDE.md + the relevant spec before continuing work. Early reads do not survive context compression.
7. **Draft spec block.** No build work proceeds against a spec marked `draft` or `stale`. KEEPER corrects the spec to `active` first. Then build begins.

### At session close:
8. **Confirm KEEPER close checklist has run.** REX does not release the session until KEEPER has completed the Session Close checklist and Daxx has approved.

---

## KEEPER Protocol — Session Open (MANDATORY)

**KEEPER runs this checklist at the start of every session — build, planning, documentation, or vault question. This is the read-first gate. It applies any time vault content will be read, referenced, or acted on.**

### Step 1 — Identify what is happening today

Name the planned work. Identify which files in the vault cover it:
- Which spec files describe the feature or module being built?
- Which tables in `schema.sql` will be read or written?
- Which DRs apply?

### Step 2 — Read the vault (non-negotiable)

| File | Why |
|---|---|
| `CLAUDE.md` Repository State | Confirm current build state matches session context |
| `open_items.md` | Identify blockers — hard gates, open decisions, "blocks build" items |
| Every spec covering today's work | Confirm status (`active` vs `draft`/`stale`) |
| `schema.sql` | Confirm current table state — field names, columns present |
| Relevant DR files | Confirm any decisions that affect today's field names or architecture |

### Step 3 — Flag before proceeding

KEEPER must explicitly flag any of these before build begins:

| Condition | Action |
|---|---|
| Spec marked `draft` or `stale` covers today's work | Correct spec to `active` first. Build after. |
| Spec has unresolved open items marked "blocks build" | Surface to Daxx. Get explicit go-ahead or resolve first. |
| Spec field names don't match `schema.sql` | Correct the spec. Never build against a spec with wrong field names. |
| A DR was locked since the spec was last updated | Update spec to reflect new DR before build begins. |
| Any "blocks build" open item in `open_items.md` is unresolved | Do not begin the blocked work. Flag to REX and Daxx. |

### Step 4 — Confirm read complete

KEEPER states explicitly: **"Vault read complete. [Any flags surfaced.] Ready to proceed."**

No build work begins before this statement. This is REX's cue to allow the session to continue.

### Rule: The vault is read-first. It is not consulted mid-session as a fallback.

The failure mode is building from memory or assumption and checking the spec afterward. That direction produces drift. Read first. Build after.

### Stale file policy: correct immediately. Mark stale only when genuinely blocked.

When a vault file is found to be inaccurate, KEEPER corrects it in the same session — not later, not after the build, not with a stale label. `stale` is reserved for files that cannot yet be corrected because required information doesn't exist (e.g., a decision hasn't been made, a schema hasn't been designed). Stale means "blocked on [X]." It does not mean "noticed it's wrong, will fix later." A file that is wrong and correctable is corrected now.

---

## KEEPER Protocol — Session Close (MANDATORY)

**KEEPER must run this checklist before any session ends where code, schema, decisions, or vault files changed. No exceptions.**

### Step 0 — Navigate First (before touching any file)

Read `VAULT_SUBSTANCE_MAP.md`. List every domain touched this session. For each domain, identify all vault files covering it. Those are your update targets — not just the governance files below.

| Domain touched | Vault file to update |
|---|---|
| Schema changed | `04_Data/Data_Model.md` |
| Architecture changed | `03_Architecture/System_Architecture.md` |
| Integration changed | relevant `05_Integrations/` file |
| New env var added | `CLAUDE.md` env var section |

### Files KEEPER must always check and update:

| File | Action |
|---|---|
| `changelog.md` | Append new session entry — what changed, what was decided, what was built |
| `00_Vault_Control/KB_FILE_REGISTRY.md` | Add any new files created this session; update status of changed files |
| `00_Vault_Control/VAULT_SUBSTANCE_MAP.md` | Add one-line summary for every new file; update stale descriptions for changed files |
| `00_Vault_Control/VAULT_INDEX.md` | Update only if folder structure changed |
| `open_items.md` | Capture any new open items, blockers, or decisions surfaced this session |
| `CLAUDE.md` | Bump version + update Repository State if build progress was made |
| Deferred-UI check | Every "skip" / "later" / placeholder CTA added this session has a corresponding OB in `open_items.md` (state: what defers, where completion lives, whether that screen exists) |

### Fast Path (Daxx approval only — no SAGE required)

These update types are low-risk, append-only, and do NOT require full SAGE review:
- Adding entries to `KB_FILE_REGISTRY.md`
- Adding entries to `VAULT_SUBSTANCE_MAP.md`
- Appending to `changelog.md`
- Adding new items to `open_items.md` (removal still requires SAGE)
- Bumping CLAUDE.md version for build state changes (not decision changes)

### Full workflow still required for:
- Structural vault changes (new folders, file moves, archival)
- Stale file remediation (changing a file's status to outdated/archived)
- Locked decision changes or additions to DECISION_LOG.md
- CLAUDE.md changes that affect architecture or locked decisions

### Rule: KEEPER proposes, Daxx approves. Silence is not approval.

KEEPER must explicitly surface proposed updates and receive confirmation. If a session ends without running this checklist, vault integrity is compromised.

---

## CLAUDE.md Version History

| Version | Date | Changes |
|---|---|---|
| v1.0 | 2026-03-07 | Initial vault setup |
| v1.1 | 2026-03-07 | Added team protocol and hard gates |
| v1.2 | 2026-03-12 | Structural update — added all domain folders, decision records, UI mockups |
| v1.3 | 2026-03-18 | DR-013 through DR-017 locked; HOG Phase 1 scoped |
| v1.4 | 2026-03-18 | KBOS compliance migration; 00_START_HERE.md, open_items.md, changelog.md added |
| v1.5 | 2026-03-25 | Dev environment complete; repo cloned and opened in VS Code; NOVA codebase review; Michael decision closed (G-07); OB-01/02/03 identified as next build tasks |
| v1.6 | 2026-03-26 | Vault path updated from Obsidian location to Business Files\AccessSync\AccessSync |
| v1.7 | 2026-03-26 | OB-04 closed — grant-revoke.js and plan-mapping-resolver.js DB layer complete. Next layer: retry-engine, reconciliation, SIGTERM. |
| v1.8 | 2026-03-26 | KEEPER Protocol — Session Close section added. Fast path for registry updates defined. Stop hook wired in Claude Code settings. |
| v1.9 | 2026-03-26 | Phase 2+3 complete. DR-020 (Resend email) + DR-021 (platform-agnostic member_identity) locked. Env vars added. Build state updated to V1 code-complete. Open items refreshed. |
| v2.0 | 2026-03-27 | Admin Hub V1 code-complete. 10 new admin/ files. Gate A schema (webhook_log, email/name, dismiss fields). Core Engine instrumented. Admin env vars added. Auth-001 (Google OAuth) and OB-12 (deploy) added as next items. |
| v2.1 | 2026-03-27 | Auth-001 closed. Google Identity Services replaces bcrypt password auth. google-auth-library added, bcryptjs removed. GOOGLE_CLIENT_ID + ADMIN_ALLOWED_EMAIL env vars replace ADMIN_PASSWORD_HASH. |
| v2.2 | 2026-03-27 | OB-12 closed — Admin Hub deployed and live at https://accesssync-admin.up.railway.app. railway-admin.toml created. Data minimization: email/name removed from member_identity. Clients schema: wix_site_id → site_id, platform + site_name added. OB-13 + OB-14 added. Debug Center search scoped to platform_member_id only. |
| v2.3 | 2026-03-28 | OB-14 closed — all 6 Railway schema migrations applied. hardware_platform + tier added to clients. Clients panel built (admin/routes/clients.js + frontend). DR-018/019 physical files created. KB_FILE_REGISTRY.md + VAULT_SUBSTANCE_MAP.md corrected (12→10 tables). |
| v2.4 | 2026-03-28 | REX Active Session Protocol + KEEPER Session Open Protocol added. Read-first gate formally enforced. Addresses root cause of spec drift across multiple sessions. |
| v2.5 | 2026-03-28 | Protocol corrections: session open applies to ALL sessions (not just build). Stale file policy added — stale is last resort for genuinely blocked files, not a deferral label. Correct inaccurate files immediately. |
| v2.6 | 2026-03-28 | 7-layer architecture (DR-022/023/024). Architecture section replaced. Repository State updated with all 7-layer file paths + shims. DR-022/023/024 locked. SPEC_Core_Engine_Architecture.md corrected to active v1.0.0. |
| v2.7 | 2026-03-28 | DR-025 locked — locations table + OD-10/11/13 schema additions. simplify review complete (parseRedisUrl extracted to redis-utils.js, dead-code catch removed, unreachable condition removed, processRevoke hardwarePlatform param, enforceRateLimit while loop). OB-15 closed. OB-16 added (Railway migrations). 12 tables total. |
| v2.8 | 2026-03-28 | OB-17 closed — plan mapping screen (/mapping.html) built and wired to live data. GET /operator/:clientId/locations/:locationId/mappings endpoint added. Dashboard Edit button navigates to mapping screen (modal removed). SPAN (QA/Test Coverage) + Lens (Live Site Monitor) agents defined. OB-10 closed. |
| v2.9 | 2026-03-28 | DR-026 locked — multi-door provisioning fix (3 bugs + SPAN P0/P1). `member_role_assignments` table + `plan_mappings.access_type`. Resolver returns Array. `payment.recovered` enableAccess-only path. `UnrecoverableError` for 4xx. OB-18 added (Railway migration). Vault cleanup: System_Architecture 5→7 layer, 3 integration placeholders replaced with real content, Data_Model 12→13 tables, 13_Decision_Records DR-026 physical file created. |
| v3.0 | 2026-03-28 | DR-027 locked — per-location subscription model. `locations` table gets `subscription_status`, `tier`, `subscribed_at`, `subscription_id`. Provisioning gated by location subscription status. Discovery Team (PIERCE/PARSE/AXIOM/REED/FAULT/VERA/MARGIN) ran full research: Wix plans confirmed site-wide (no location in webhooks), Kisi API key confirmed org-scoped (one key covers all Places). OB-03-A updated — `instanceId` in JWT body (not header). OB-19–22 added. |
| v3.1 | 2026-03-28 | DR-028 locked — Kisi API key storage. `clients.kisi_api_key` + `locations.kisi_api_key` (nullable override). AES-256-GCM via `core/crypto-utils.js` + `KISI_ENCRYPTION_KEY` env var. `KISI_API_KEY_MOCK` deprecated. OB-19 expanded (6 ALTER statements). OB-23 added (crypto-utils build + kisi-connector DB lookup). |
| v3.2 | 2026-03-29 | OB-03-A, OB-08, OB-20, OB-05 closed. `core/location-lapse.js` + `admin/public/onboard.html` built. Member Sync panel + full location CRUD added. OB-13 unblocked. |
| v3.3 | 2026-03-29 | Operator-facing wizard complete. Auth gate removed from `onboard.html`. Three public signup endpoints added to `admin/routes/operator.js` (`POST /operator/clients`, `/locations`, `/api-key`). Pro tier description corrected (high-traffic door, not multiple zones). Step 5 amber API key reminder + `state.apiKeySkipped` flag. "Back to Admin" links removed; Step 5 links to `/dashboard.html`. Deferred-UI Rule added to Team Protocol. KEEPER Session Close checklist updated. OB-24, OB-25, OB-26 logged. |
| v3.4 | 2026-03-30 | Vault audit complete — all 39 files confirmed in repo. OB-22 closed. Wix Velo `events.js` written. OB-37 closed — API key test endpoint + Admin Hub Test Key button. P1 fix (req.rawBody) + DEFAULT_TENANT_ID fallback applied. `operator_locations.html` built — Platform Config tab with org-level key card + per-location key override + inline test. 2 new operator.js endpoints (location api-key POST + test GET). All 5 Platform Config sub-nav links wired (were href="#"). OB-35, OB-36, OB-38 logged. Vault-First Question Rule + Deferred-UI enforcement applied. |
| v3.5 | 2026-03-31 | **Sessions 14+15 vault catch-up.** Session 14: site_id auto-registration (`registerSiteId()` + `X-AccessSync-Client-Id` header), personalized `events.js` code block in onboard Step 5, full onboarding UX overhaul (5 steps rewritten — honest headlines, gym-language bullets, pricing transparency, skip button removed). Session 15: 6 static HTML operator pages refactored to EJS server-side templates (`admin/views/pages/` + `admin/views/partials/`). Shared `operator-nav.js` (subnav, dark mode, toast, esc) + `operator-styles.css`. `ejs` package added. 6 Express routes added to `admin/server.js`. `showToast()`/`esc()` consolidated. OB-27/OB-30 superseded by EJS refactor. |
| v3.6 | 2026-03-31 | **Session 16: Owner bypass PIN + onboarding client-deferral refactor.** `POST /operator/verify-bypass` endpoint validates PIN against `OWNER_PIN` env var. onboard.html Step 4: subtle "Owner" link reveals PIN input, bypasses Kisi key requirement. Client creation deferred from Step 2 to Step 4 via `_provisionClient()` — no DB writes until operator completes flow. OB-36 dead code cleaned (skipApiKey, apiKeySkipped, stale toast). members.ejs expand toggle bug fixed. `OWNER_PIN` env var added. OB-40 through OB-45 added (onboarding completion gap analysis). Post-session commits: email format validation (Step 1), root `/` redirect to `/dashboard`, broken `wix-application` import removed from events.js template, `OWNER_BYPASS_PIN` → `OWNER_PIN` rename. OB-46/47 added (post-purchase member page, plan mapping live data). `docs/project-plan.html` created — full 4-sprint visual plan. |
| v3.8 | 2026-04-01 | **Session 21: Business-risk-aware test framework (Concept #6).** 9 new files. Jest + custom reporter + priority sequencer. `test/business-priorities.json` defines P1–P5 tiers by business consequence. P1 = churn risk (member pays, door doesn't open). `npm run test:deploy` runs P1+P2+P3 and outputs DEPLOY SAFE or DO NOT DEPLOY. 32 tests passing: 12 P1 (grant/revoke/suspend), 8 P2 (crypto), 12 P3 (wix-adapter parsing). |
| v4.0 | 2026-04-02 | **AI-forward knowledge base complete.** 6 new docs (index, data-model, decision-log, feature-map, operations, endpoints already existed). llms-full.txt (full context dump). All 3 existing docs enhanced with AI_CONTEXT blocks + breadcrumb + `<link rel="alternate">`. llms.txt built in v3.9. F038 vault discrepancy caught and corrected (Feature_Map.md updated). OB-58 + OB-59 added. |
| v3.9 | 2026-04-01 | **Sprint 5 complete — platform-agnostic hardening + operator safety net.** DR-035: `kisi_api_key` → `hardware_api_key`, `wix_plan_id` → `source_plan_id`. Hardware platform resolved from DB. getLocks() normalized. assignRole() Gap 6 (validUntil). Worker concurrency 20. `OPERATOR_NOTIFICATION_EMAIL` → `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL`. Sprint 5.1: HMAC spike alerting (hmac-monitor.js). Sprint 5.2: Hardware health check cron (hardware-health-check.js). Sprint 5.3: Alert email UI (locations.ejs card + operator.js GET/PUT). Sprint 5.4: Same-group duplicate warning (plan-mapping.ejs). Sprint 5.5: First grant email (standard-adapter.js atomic flag). Sprint 5.6: CSV export (members.ejs + access.ejs). Sprint 5.7: Suspend/reactivate button (locations.ejs). OB-51 logged (Resend env vars). 2 docs, 2 migrations, 6 new/modified files committed and pushed. |
| v3.7 | 2026-04-01 | **Sessions 17–20: All 4 project-plan sprints complete.** Sprint 1: OB-44/45 (location activation endpoint + auto-activate in `_provisionClient()`), P6 (wix-adapter.js multi-path field resolution), OB-42 (`kisi-adapter.getGroups()` + `/kisi-groups` endpoint), OB-41 (webhook secret instructions in Step 5), OB-06 (member-sync-api enriched with plan/door/location). Sprint 2: OB-46 (`sync-status.ejs` — 4-state polling page, OI-05 stale indicator). Sprint 3: OB-29 (all 4 EJS pages wired to live data), OB-31/32 (access-log + access-stats endpoints), OB-35/38 (API key status/test/PUT on operator path), OB-13 (Debug Center email search via Wix Members API). Sprint 4: OB-24 (`requireInviteToken` middleware + rate limiter), OB-26 (dashboard "Connect Kisi" amber banner), OB-43 (onboard Step 5 `runValidation()` system check). `OPERATOR_INVITE_TOKEN` env var added. |
