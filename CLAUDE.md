# CLAUDE.md — AccessSync
**Version:** 4.17 | **Updated:** 2026-05-05 | **Author:** Daxx Roberts / KEEPER

> **Read this file before writing a single line of code. Then read `open_items.md`. Then read the spec for what you're building.**

---

## What This Is

AccessSync is a SaaS product that automates physical space access control for fitness operators and SMBs. When a member purchases a pricing plan through a connected membership or booking platform, AccessSync automatically provisions their access credentials in the hardware access control system. No manual operator action required.

**AccessSync is platform-agnostic at its core.** The architecture supports any membership/booking platform (currently: Wix) and any hardware access control platform (currently: Kisi; Seam stubbed for post-V1). Strip the Wix layers and everything underneath runs identically with a different platform connector.

**First client:** House of Gains (Chad) — Kisi Pro tier, $199/mo/location.

---

## Deployment Environment

**Railway only.** All services, databases, and cron jobs run on Railway. Never:
- Start a local dev server
- Create a `.env` file for local use
- Suggest `localhost` testing
- Run Railway CLI commands to proxy local connections

**Hardcoded URLs — use these directly. Never run `railway variables` to look them up:**

| Service | Public URL |
|---|---|
| Core Engine | `https://accesssync-production.up.railway.app` |
| Admin Hub | `https://accesssync-admin.up.railway.app` |
| Postgres | `postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway` |

The Railway CLI is not always linked. Use Node.js (`pg` package) to run SQL — `psql` may not be on PATH. Standard pattern for migrations and dry-runs:
```js
const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway',
  ssl: { rejectUnauthorized: false }
});
```

**Deploying to Railway:** `git commit` + `git push` — Railway auto-deploys from GitHub. Never use `railway up`, `railway redeploy`, or any Railway CLI deploy command. After pushing, poll the live endpoint — new deploys take ~30s. Always verify the deploy landed by hitting a live endpoint, not just checking git log.

**Getting Railway env vars (secrets only — for values NOT listed above):** `railway variables` table output truncates long values. Always use `--json` and parse with python3:
```
railway variables --service <name> --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('VAR_NAME'))"
```
The Railway CLI may not be linked. If `railway variables` fails, check the memory file `reference_railway_db.md` or ask Daxx directly.

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

**All 4 project-plan sprints complete. Business-risk-aware test framework live: 258 tests across P1/P2/P3 tiers, DEPLOY SAFE. End-to-end provisioning pipeline working. Member-facing sync status page live. Operator console wired to live data. Sprint 5 complete. 6 operator UI screens live. OB-46 closed 2026-04-18 (`member_access_sources` live). First real HOG member grant confirmed 2026-04-23. OB-47 closed 2026-04-27 (pre-grant source check live — DR-034 multi-source safety complete). Logging Foundation Sprint (DR-037/038/039) fully shipped: ALS trace context, redaction, diagnostic_log, activity_event, EVENT_REGISTRY, 258 tests. Members Page v2 shipped 2026-04-27 — React 18 + Babel-standalone island replaces the prior EJS+vanilla-JS members page; bridge adapts the operator API to the new design's shape. Sprint 6 (Trace Timeline UI — Daxx-only diagnostic spine over `v_trace_timeline`) scoped 2026-04-28 — pending Phase 1 prerequisites (OB-117 untraced-event quantification, OB-120 dr-041 deployment verification, EVENT_REGISTRY gap-fill for `humanize()`). Pending: OB-19 (Railway env vars), OB-49 nightly global reconcile, OB-93 (HOG events.js reinstall), OB-109–112 (Members v2 follow-up: Svelte port post-HOG, door-entries stat, MoM delta, plan rate field), OB-113–120 (Sprint 6 Trace Timeline UI scope + prerequisites), business gates G-01/02/05/06.**

**Current status as of 2026-04-27 (v4.13):**
- `schema.sql` — DR-018 through DR-035 applied. 13 tables in Railway DB today; 14th table (`member_access_sources`, DR-034) pending OB-46 migration. `member_role_assignments` (DR-026), `access_type` on `plan_mappings` (DR-026), `hardware_api_key` columns (DR-035), `source_plan_id` (DR-035), `hardware_key_last_verified` + `hardware_key_last_error` on `locations` (sprint-5), `first_grant_sent` on `clients` (sprint-5).
- `db.js` — ✅ Built. pg pool, query helper, `getClient()`, `healthCheck()`, `pool` exported.
- `adapters/wix/wix-connector.js` — ✅ Layer 1. HTTP handler, HMAC verification (uses `req.rawBody`). Reads `X-AccessSync-Client-Id` header → calls `tenantResolver.registerSiteId()` for self-registration. Calls wix-adapter.parseEvent(). On HMAC rejection: calls `hmacMonitor.recordFailure()` (Sprint 5.1).
- `adapters/wix/wix-adapter.js` — ✅ Layer 2. Wix payload parsing only. parseEvent() → standard event object. Zero dependencies. Multi-path resolution for memberId + planId across Pricing Plans, Bookings, and Members event structures (P6 fix). `_normalizeEventType()` covers `orderAutoRenewCanceled` and `orderEnded` (both → `plan.cancelled`) — commit `f883cc8`.
- `adapters/standard-adapter.js` — ✅ Layer 3. Owns member_identity, member_access_state, member_access_sources (DR-034), in_flight lock (DR-023). resolveAndLock(), resolveIdentity(), completeGrant() (pre-grant source check, OB-47 closed), completeRevoke() (source-row delete + remaining-count check before hardware removeRole, OB-48 closed). releaseLock(). Writes client_activity_summary (DR-024). `_maybeFireFirstGrantEmail()` — atomic first-grant welcome email per client (Sprint 5.5).
- `adapters/hardware-adapter.js` — ✅ Layer 5. Hardware platform router. Delegates to kisi/seam by hardwarePlatform string (DR-022). `assignRole()` passes `options.validUntil` through (Gap 6). `getRateLimit()` returns req/sec per platform (informational).
- `adapters/kisi/kisi-adapter.js` — ✅ Layer 6. Kisi business methods. Calls kisi-connector. `getGroups(apiKey)` — `GET /groups` for plan mapping dropdown (OB-42). `assignRole()` supports `options.validUntil` → `valid_until` (Gap 6). `getLocks()` returns normalized `{ id, name, locked: boolean }` shape.
- `adapters/kisi/kisi-connector.js` — ✅ Layer 7. Kisi HTTP client, rate limiting, auth headers.
- `adapters/seam/seam-adapter.js` — Stub. Layer 6 equivalent. Post-V1.
- `adapters/seam/seam-connector.js` — Stub. Layer 7 equivalent. Post-V1.
- `adapters/wix-adapter.js` — Shim → `./wix/wix-connector` (DR-022 backward compat).
- `adapters/kisi-adapter.js` — Shim → `./kisi/kisi-adapter` (DR-022 backward compat).
- `adapters/seam-adapter.js` — Shim → `./seam/seam-adapter` (DR-022 backward compat).
- `server.js` — ✅ Fully implemented. Imports `adapters/wix/wix-connector` (DR-022). DB health check, BullMQ worker boot, SIGTERM graceful shutdown.
- `core/queue-worker.js` — ✅ Built. Layer coordinator. Calls standardAdapter (resolve/lock/complete) around grantRevokeLogic. `payment.recovered` early-exit path (enableAccess only). `UnrecoverableError` for 4xx errors (DR-026). Concurrency: 20 (rate limiting moved to per-adapter connectors).
- `core/hmac-monitor.js` — ✅ Built (Sprint 5.1). Redis sliding window HMAC failure counter. 3 failures in 5 min → Resend alert to `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL`. 10-min cooldown key prevents alert storm. Non-blocking — never interrupts webhook flow.
- `core/hardware-health-check.js` — ✅ Built (Sprint 5.2). 6-hourly Railway Cron. Tests each active client's `hardware_api_key` via `getLocks()`. 401 = invalid key, 403 = permissions error, no key = config missing. Sends specific diagnosis email per failure type. Updates `locations.hardware_key_last_verified` + `locations.hardware_key_last_error`.
- `core/tenant-resolver.js` — ✅ Built. `site_id` → `client_id` with 5-min cache. `registerSiteId(clientId, siteId)` — idempotent UPDATE for self-registration. `DEFAULT_TENANT_ID` fallback auto-wires real `site_id` on first webhook.
- `core/webhook-processor.js` — ✅ Built. BullMQ Queue, real DB dedup, tenant resolution, `eventQueue` exported.
- `core/plan-mapping-resolver.js` — ✅ Built. Returns Array of all active mappings (DR-026). `status='active'` filter. Includes `mappingId` + `accessType`. Resolves per-mapping `hardware_api_key` (DR-028/DR-035).
- `core/grant-revoke.js` — ✅ Built. `processGrant` loops all mappings[], returns `assignments[]`. `processRevoke` loops all `roleAssignmentIds[]`. Identity/lock/state owned by Standard Adapter (DR-023). `newHardwareCallMade` flag gates `member_access_log` INSERT to real hardware calls only — prevents duplicate `provisioned` entries from Wix multi-fire events (`orderCreated`/`orderPurchased`/`orderStarted`) — commit `d41a25e`.
- `core/retry-engine.js` — ✅ Built. `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/reconciliation.js` — ✅ Built. Calls hardwareAdapter.getLocks(). Stale lock cleanup, failed job re-queue, operator digest. **2026-04-26: added `reconcileMember(memberId, clientId)`** — per-member Wix/Kisi/DB diff with DB-row-gap detection. Detects drift in `member_role_assignments` + `member_access_sources` (the gap that surfaces "no hardware role assignment" when an operator edits a plan mapping). Queues repairs through L3 via synthetic `plan.purchased` events — never writes tracking tables directly (DR-023). Surfaces 4 integrity issues to operator via `config_alert_log`. Closes OB-49 at per-member level; nightly global version still pending.
- `core/member-sync-api.js` — ✅ Built. RS256 JWT verification live (OB-08 closed). Returns enriched access array: plan names, door names, location info (OB-06 enrichment). **Fixed 2026-04-24 (commit `3b2def8`):** `rolesResult` query was referencing `mra.hardware_role_id` (non-existent column) and `mra.status = 'active'` (no status column on `member_role_assignments`) — caused 500 on every `/member/access-status` call. Now selects `mra.role_assignment_id` and removes the dead WHERE filter.
- `core/location-lapse.js` — ✅ Built (OB-20). `suspendLocationMembers()` — suspends all active members at a location when subscription lapses. Admin routes: POST /admin/clients/:id/locations/:locationId/suspend + /activate.
- `core/crypto-utils.js` — ✅ Built. AES-256-GCM encrypt/decrypt for `hardware_api_key` + `wix_api_key` (DR-028).
- `core/wix-plans-api.js` — ✅ Built (OB-62). Wix REST API client. Authorization: bare API key in header, `wix-site-id` header. Required permissions: Pricing Plans + Bookings read.
- `admin/server.js` — ✅ Built. Separate Express app. Crash-isolated from Core Engine. EJS view engine (`admin/views/`). Mounts `portalRoutes` at `/operator-portal`. 5 operator page routes (`/dashboard`, `/members`, `/plan-mapping`, `/access`, `/locations`) use `requireAuthPageOrOperator` — accepts adminToken or operatorToken. `/admin-panel` uses `requireAuthPage` (owner only). `/onboard` route has **no auth gate** (new operators have no cookie; invite token gate on APIs is the security boundary) — renders `pages/onboard` with `{ clientId, instanceId, inviteToken }` injected server-side. `allowWixFrame` middleware removes `X-Frame-Options` and sets `frame-ancestors 'self' https://manage.wix.com` on all iframe-loaded routes.
- `admin/middleware/auth.js` — ✅ Built. JWT httpOnly cookie.
- `admin/middleware/activity.js` — ✅ Built (2026-04-27). `recordActivity(req, event, ctx)` — fire-and-forget INSERT to `activity_event` with actor+traceId from ALS. Never blocks response. Wired into 7 mutation routes in operator.js. (DR-037)
- `admin/middleware/trace-context.js` — ✅ Built. `traceContextMiddleware` + `resolveActor`. Mounts ALS context on every Express request. (DR-037) `signToken()` (admin 24h). `signOperatorToken(clientId)` (operator 8h, scoped to clientId). `requireAuth` (API routes). `requireAuthPage` (admin page routes, redirects on failure). `requireAuthPageOrOperator` (operator page routes — accepts adminToken or operatorToken cookie).
- `admin/routes/auth.js` — ✅ Built. Google OAuth.
- `admin/routes/portal.js` — ✅ Built. GET `/operator-portal`: verifies Wix signed instance (`requireWixInstance`), issues `operatorToken` cookie (`sameSite: 'none'` for iframe), checks setup status (no API key AND no locations → redirect to `/operator-portal/setup`, otherwise → `/dashboard?clientId=...`). GET `/operator-portal/setup`: protected by `requireAuthPageOrOperator`, renders `portal-setup.ejs` with `{ clientId, inviteToken }`.
- `admin/routes/errors.js` — ✅ Built. Full Error Queue CRUD + BullMQ retry.
- `admin/routes/members.js` — ✅ Built. Debug Center — search (email detection → Wix Members API resolve → ILIKE fallback), timeline, retry.
- `admin/routes/webhooks.js` — ✅ Built. Webhook Inspector — recent + detail.
- `admin/routes/queue.js` — ✅ Built. Queue Monitor — counts + jobs by state.
- `admin/routes/clients.js` — ✅ Built. Clients panel — GET / (with member counts), PATCH /:id. GET /:id/api-key/test (validates stored key against Kisi GET /groups?limit=1).
- `admin/routes/operator.js` — ✅ Built. POST /operator/verify-bypass (owner PIN). Signup endpoints protected by `requireInviteToken` middleware + 5 req/IP/min rate limiter (OB-24). Full operator API: paginated members, config alerts, error summary, location management, hardware API key management, notification email (Sprint 5.3), onboarding, hardware groups, access log, access stats, plan mappings. Invite token middleware on signup endpoints. **2026-04-26: added `POST /:clientId/members/:memberId/sync`** — per-member reconcile triggered from member drawer Reconcile button. Calls `reconciliation.reconcileMember()` and returns structured `{ action, granted, revoked, repaired, alerts }`. **Fixed 2026-04-24 (commit `d10a69d`):** client query now includes `source_site_name` as fallback for site label; locations query COALESCEs `hardware_platform` from client row when location row is NULL.
- `admin/views/pages/dashboard.ejs` — ✅ Live data. Amber "Connect your hardware API key" banner when key missing (OB-26). Hardware platform chip shows amber "No Key" pill. **Fixed 2026-04-24 (commit `d10a69d`):** Wix chip pill now conditioned on `last_webhook_at` (was hardcoded "Live" green — column name is `last_webhook_at`, NOT `last_wix_webhook_at`). Site label falls back to `source_site_name` when `source_site_url` is null. Plan mapping sub-section shows last-6-char `source_plan_id` disambiguator when two plans share the same name. Also added `admin/views/pages/onboard.ejs` two new Velo handler exports: `onOrderAutoRenewCanceled` and `onOrderEnded` — commit `f883cc8`.
- `admin/views/pages/members.ejs` — ✅ **REPLACED 2026-04-27 (v4.13).** Now a thin EJS shell that mounts the Members Page v2 React island. Topbar/subnav partials retained. Inline `<style>` block holds the new design CSS verbatim. Server-injects `window.__CLIENT_ID` from `req.admin.clientId`. Loads React 18 + Babel-standalone from CDN, then `/members-bridge.js`, then 5 JSX files (`tweaks-panel.jsx` → `members-data.jsx` → `members-icons.jsx` → `members-parts.jsx` → `members-app.jsx`). Email search + CSV export retained inside the React app. No family grouping code. The 2026-04-26 Reconcile Member button + result panel from the prior version is NOT carried into v2 — re-add post-HOG when re-evaluating Members surfaces (OB-LOG-01 will surface the gap during the audit).
- `admin/public/members-bridge.js` — ✅ Built (2026-04-27, v4.13). API → React data adapter for the Members Page v2. Maps the operator API response to the prototype's data shape: flat snake_case → nested camelCase, `effective_status` enum → 4-state enum, sub-members nested under their holder via `plan_holder_id`. Fans out 3 parallel fetches (members?limit=200, error-summary, /admin/clients/:id), populates `window.MEMBERS` + `window.__MEMBERS_CONTEXT`, fires `membersLoaded` custom event. `clientId` resolution chain: `window.__CLIENT_ID` → meta tag → body attr → URL param.
- `admin/public/members-app.jsx` / `members-data.jsx` / `members-icons.jsx` / `members-parts.jsx` / `tweaks-panel.jsx` — ✅ Built (2026-04-27, v4.13). React 18 + Babel-standalone components for the Members Page v2. App reads `members` from React state initialized from `window.MEMBERS`, listens for `membersLoaded`. All filter/sort/pagination client-side. `tweaks-panel.jsx` is a dev tool that stays invisible in production (no UI surface posts the activate message).
- `admin/views/pages/plan-mapping.ejs` — ✅ Live data. Real hardware groups. Inline amber warning when 2 plans share same group (Sprint 5.4). Multi-group junction table wired.
- `admin/views/pages/access.ejs` — ✅ Live data. Bar chart. CSV export respects active event + location filters (Sprint 5.6).
- `admin/views/pages/locations.ejs` — ✅ API key management + notification email card (Sprint 5.3). Per-location API key override. Suspend/reactivate button (Sprint 5.7).
- `admin/views/pages/admin-panel.ejs` — ✅ Built. Mock data.
- `admin/views/pages/sync-status.ejs` — ✅ Built (OB-46). Member-facing post-purchase sync status page at `/sync-status?memberId=X&clientId=Y`. 4 visual states: syncing, active, error, pending. Polls `/member/access-status` every 3s, max 60 polls. Stale data indicator: amber badge after 30s (OI-05).
- `admin/views/partials/head.ejs` — ✅ Shared `<head>` — meta, Sora font, operator-styles.css link.
- `admin/views/partials/topbar.ejs` — ✅ Shared topbar — AccessSync logo, sync badge, dark mode toggle.
- `admin/views/partials/subnav.ejs` — ✅ Shared sub-nav container — `data-active` drives tab highlighting via operator-nav.js.
- `admin/public/operator-nav.js` — ✅ Shared JS — sub-nav rendering (6 tabs), dark mode toggle, `showToast()`, `esc()` utility.
- `admin/public/operator-styles.css` — ✅ Shared CSS — all operator page styling. Sora font, CSS variables, responsive.
- `admin/public/onboard.html` — ❌ DELETED 2026-04-08. Replaced by `admin/views/pages/onboard.ejs`.
- `admin/views/pages/onboard.ejs` — ✅ Multi-step onboarding (converted from onboard.html). Invite token injected server-side at render time via EJS (`<%= inviteToken %>`). `instanceId` injected server-side (`<%= instanceId %>`). Step 1 Site ID field: hidden when `_instanceId` truthy (portal path — auto-wired); shown when falsy (manual/owner path). Pre-fills from `?siteId=` URL param (set by portal redirect for new operators). `siteIdVerified` flag — Test button must return valid before `nextStep1()` allows progression on manual path. Input change resets verified flag. Invite token gate. Owner bypass PIN path. System Check panel (`runValidation()`). Webhook secret instructions. Hardware group summary after key validation.
- `admin/views/pages/portal-setup.ejs` — ✅ Operator portal setup landing page. Shown when client has no API key and no locations. "Start Setup" CTA links to `/onboard`. No topbar/subnav — pre-setup context.
- `admin/middleware/wix-instance.js` — ✅ Verifies Wix signed instance token (HMAC-SHA256 with `WIX_APP_SECRET`). Rejects anonymous users (`aid` field). Confirms site owner (`uid === siteOwnerId` OR `permissions === 'OWNER'`). Resolves `clientId` from `clients.site_id = instanceId`. Sets `req.wixOperator = { clientId, instanceId, uid }`. **No-client-found path redirects to `/onboard?siteId=<instanceId>` (new operators) instead of 403.** Exports `requireWixInstance`, `verifySignedInstance`.
- `docs/what-is-accesssync.html` — ✅ Operator-facing explainer — platform boxes, 4-step flow, before/after, pricing tiers.
- `docs/architecture.html` — ✅ 7-layer architecture explainer — layer stack, standard event contract, hardware interface, adapter growth matrix.
- `docs/endpoints.html` — ✅ All 77 API endpoints across Core Engine and Admin Hub.
- `docs/index.html` — ✅ KB hub page — nav to all 8 docs, project status, sprint summary, hard gates table.
- `docs/data-model.html` — ✅ All 14 tables, column-level detail, layer ownership badges, DR chips.
- `docs/decision-log.html` — ✅ All 35 DRs as lockable cards grouped by domain.
- `docs/feature-map.html` — ✅ 38 features across 5 categories.
- `docs/operations.html` — ✅ All env vars, Railway services, migration order, pre-deploy checklist, hard gates.
- `llms-full.txt` — ✅ Full context dump — all 8 doc sections concatenated, markup stripped. ~400 lines.
- `core/EVENT_REGISTRY.md` — ✅ Built (2026-04-27). Full taxonomy of all log events (~50 events across 11 namespaces). Governed by DR-038. New events require an entry before shipping.
- `core/redaction-allowlist.json` — ✅ Built (2026-04-27). always_safe / never_log / redact_if_pattern_matches field lists. Governed by DR-039.
- `migrations/dr-035.sql` — ✅ Platform-agnostic schema renames. Run on Railway before Sprint 5 code deploy. ✅ Applied 2026-04-02.
- `migrations/sprint-5.sql` — ✅ Sprint 5 columns: `hardware_key_last_verified`, `hardware_key_last_error`, `first_grant_sent`. ✅ Applied 2026-04-02.

---

## Architecture — 7-Layer Model (DR-022)

```
Layer 1: Wix Connector            adapters/wix/wix-connector.js
  HTTP handler, HMAC-SHA256 verification only. Calls Layer 2.

Layer 2: Wix Adapter Layer        adapters/wix/wix-adapter.js
  Wix payload parsing. parseEvent() → standard event object. Zero dependencies.

Layer 3: Standard Adapter Layer   adapters/standard-adapter.js
  Owns member_identity, member_access_state, member_access_sources (DR-034), in_flight lock.
  resolveAndLock(), resolveIdentity(), completeGrant() (pre-grant source check, OB-47 pending),
  completeRevoke() (source-count check, OB-48 pending), releaseLock().
  Daily client_activity_summary UPSERT (DR-024). First grant email (Sprint 5.5).

Layer 4: Core Engine              core/
  webhook-processor.js     Deduplication, BullMQ enqueue
  queue-worker.js          Layer coordinator — orchestrates L3+L4+L5
  grant-revoke.js          Pure grant/revoke logic + hardware calls via L5
  plan-mapping-resolver.js  source_plan_id → hardware group lookup (DR-035)
  retry-engine.js          Exponential backoff, dead-letter to error_queue
  reconciliation.js        Nightly sweep (pending OB-49 for member_access_sources)

Layer 5: Hardware Standard Adapter  adapters/hardware-adapter.js
  Platform router. Delegates to Layer 6 by hardwarePlatform string.
  Interface: findUserByEmail, createUser, assignRole, removeRole,
             suspendAccess, enableAccess, deleteUser, getLocks

Layer 6: Kisi Adapter Layer       adapters/kisi/kisi-adapter.js
  Kisi business methods. Calls Layer 7 for all HTTP.

Layer 7: Kisi Connector           adapters/kisi/kisi-connector.js
  Kisi HTTP client, rate limiting (DR-008), auth headers.
```

**Backward-compat shims (DR-022):** `adapters/wix-adapter.js` → L1. `adapters/kisi-adapter.js` → L6. `adapters/seam-adapter.js` → L6 stub.

**Queue layer:** BullMQ + Railway Redis. `webhook-processor.js` enqueues `'grant'`/`'revoke'` jobs. `queue-worker.js` coordinates: resolveAndLock → resolveIdentity → grantRevokeLogic → completeGrant/Revoke. Dead-letter via `worker.on('failed')` → `retry-engine`.

**Platform adapter contract (DR-021):** All adapters set `platformMemberId` + `sourcePlatform` in the normalized event object. Core Engine never references platform-specific IDs.

**Hosting:** Railway. Entry: `server.js`. Crons: `node core/reconciliation.js` (nightly), `node core/hardware-health-check.js` (every 6 hours). Health: `GET /health`.

---

## Schema — 14 Tables

**13 tables in Railway DB today. 14th (`member_access_sources`, DR-034) pending OB-46 migration. 15th (`client_subscriptions`, DR-036) pending OB-70 migration. All other migrations through DR-035 + sprint-5.sql + multi-group-archive-audit.sql applied. See `04_Data/Data_Model.md` for full schema.**

| Table | Purpose |
|---|---|
| `clients` | One row per operator account. `hardware_api_key` (encrypted, DR-028/DR-035), `notification_email`, `first_grant_sent`, `last_webhook_at` (NOT `last_wix_webhook_at` — confirmed against live DB 2026-04-24), `wix_api_key` (encrypted), `source_site_name`. |
| `locations` | One row per physical location. `subscription_status`, `tier`, `hardware_api_key` (per-location override), `hardware_key_last_verified`, `hardware_key_last_error` (sprint-5, DR-035). |
| `plan_mappings` | Maps `source_plan_id` (DR-035, was `wix_plan_id`) to location. `access_type`, `plan_name`, `door_name`, `status`. Multi-group via junction table. |
| `member_identity` | Platform-agnostic member record. `platform_member_id`, `source_platform`, `hardware_platform`, `hardware_user_id`. |
| `member_access_state` | Current access state per member. `in_flight` lock (DR-023). |
| `member_access_sources` | Multi-source grant/revoke (DR-034). One row per member-per-mapping-per-source. **OB-46 migration pending — table does not exist in Railway DB yet.** |
| `member_role_assignments` | One row per member per mapping (DR-026). UNIQUE constraint. Enables multi-door provisioning. |
| `member_access_log` | Lifecycle audit log. |
| `processed_event_ids` | Idempotency table (DR-010). |
| `error_queue` | Dead-letter + operator-visible errors. |
| `adapter_admin_log` | Operator configuration issues. `configured_by`, `configured_at` (DR-019). |
| `webhook_log` | Raw inbound webhook record. |
| `client_activity_summary` | Daily UPSERT per client — events_received, grants_completed, revokes_completed, errors_count (DR-024). |
| `config_alert_log` | Configuration issue alerts. |

**Column name notes (DR-035):**
- `kisi_api_key` → `hardware_api_key` on both `clients` and `locations`
- `wix_plan_id` → `source_plan_id` on `plan_mappings`
- `hardware_key_last_verified` + `hardware_key_last_error` on `locations`

---

## Locked Decisions — Do Not Revisit Without SAGE

| DR | Decision |
|---|---|
| DR-001 | No PII storage — re-pull email from platform at reconciliation |
| DR-003 | `source_tag = 'accesssync'` on all managed users — distinguishes from manual |
| DR-005 | Hardware lockdown override — actions skip, not fail |
| DR-007 | Managed users — provisioned with `send_emails: false`. HOG exception: DR-017. |
| DR-008 | Pricing — $30/$60/$150 (Base/Pro/Connect). Rate limit: 5 req/sec (Kisi). |
| DR-009 | HMAC-SHA256 signature verification on all inbound webhooks |
| DR-010 | Idempotency via `processed_event_ids` table |
| DR-011 | Kisi routes direct API, not through Seam |
| DR-012 | BullMQ on Railway Redis for job queue |
| DR-013 | `member_identity` A/B schema concept — column names superseded by DR-021. |
| DR-014 | Color system — Indigo `#4F6EF7` (`--brand`) / Sage `#4ADE80` (`--sage`). Non-interchangeable. Never swap brand for status or status for brand. |
| DR-015 | Mobile-first UI — 320px baseline. FORGE + LENS enforce. |
| DR-016 | HOG Phase 1: Velo direct install, not App Market packaging |
| DR-017 | HOG Phase 1: Regular users, Terminal Pro pattern. DR-007 still applies to all other clients. |
| DR-018 | `last_sync_at` as column on `clients` table. Separate sync_state table deferred to V2. |
| DR-019 | `adapter_admin_log` — `configured_by` + `configured_at` nullable columns. |
| DR-020 | Operator email via Resend SDK. `clients.notification_email` per-client; `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` env var is platform-owner fallback. |
| DR-021 | `platform_member_id` + `source_platform` — platform-agnostic member identity. UNIQUE: `(client_id, source_platform, platform_member_id)`. |
| DR-022 | 7-layer architecture — canonical layer model, file paths, shim pattern. |
| DR-023 | Standard Adapter Layer (L3) exclusively owns `member_identity` UPSERT, `member_access_state` writes, in_flight lock. Core Engine never writes these tables directly. |
| DR-024 | `client_activity_summary` — Standard Adapter Layer, daily UPSERT. Fault-tolerant — never blocks grant/revoke. |
| DR-025 | `locations` table. `clients`: +site_url, +last_webhook_at (column confirmed as `last_webhook_at` — not `last_wix_webhook_at`). `plan_mappings`: +location_id, +plan_name, +door_name, +status. |
| DR-026 | Multi-door provisioning — `member_role_assignments` table. `payment.recovered` = enableAccess only. `UnrecoverableError` for non-retryable 4xx. Legacy fallback: `member_access_state.role_assignment_id` if `member_role_assignments` empty. |
| DR-027 | Per-location subscription model. `plan-mapping-resolver.js` filters `subscription_status = 'active'` locations. |
| DR-028 | Hardware API key storage — `clients.hardware_api_key` (org default, encrypted) + `locations.hardware_api_key` (nullable override). AES-256-GCM via `core/crypto-utils.js` + `KISI_ENCRYPTION_KEY` env var. Lookup: location key \|\| client key. `KISI_API_KEY_MOCK` removed (OB-23 closed). |
| DR-029 | Sub-member ID format — `{wix_uuid}###as{NNN}`. **⚠️ DEFERRED — family plan build post-HOG.** |
| DR-030 | `plan_holder_id` on `member_identity` + `member_access_state`. NULL for single/booking members. **⚠️ DEFERRED.** |
| DR-031 | Upstream explosion pattern — family events exploded in Layer 2. Core Engine unchanged. **⚠️ DEFERRED.** |
| DR-032 | Family plan draft→submit workflow. No provisioning until submit. **⚠️ DEFERRED.** |
| DR-033 | Unified member access widget — single HTML, 3 modes via `planType`. **⚠️ DEFERRED.** |
| DR-034 | `member_access_sources` — multi-source grant/revoke. Pre-grant source check. Revoke fires hardware DELETE only when all sources gone. **OB-46/47/48 closed.** |
| DR-035 | Platform-agnostic column renames: `kisi_api_key → hardware_api_key`, `wix_plan_id → source_plan_id`, `hardware_key_last_verified`, `hardware_key_last_error`. Migration applied 2026-04-02. |
| DR-036 | `client_subscriptions` table — platform-agnostic billing record per operator subscription. `subscription_source` + `subscription_id` pattern mirrors DR-021. `locations.tier_subscription_id` FK links each location to its subscription. Supersedes `locations.tier`, `locations.subscription_status`, `locations.subscription_id`, `plan_mappings.tier_name`. 6-phase migration. New module: `subscription-manager.js`. OB-65–OB-73 open. |
| DR-040 | Per-plan sub-member assignment — `member_identity.plan_mapping_id UUID REFERENCES plan_mappings(id) ON DELETE SET NULL`. NULL for primary members. Quota is per-plan (not pooled across all of a holder's plans), so a holder with multiple multi-member plans gets separate sub-member pools. Migration: `migrations/dr-040.sql`. Originally numbered DR-037; renumbered 2026-04-27 to resolve collision with the Observability sprint's formally-proposed DR-037. (DR-037–DR-039 are the Observability sprint trio: trace/actor context, event registry, redaction allowlist — see `13_Decision_Records/DECISION_LOG.md`.) |

Full decision records: `AccessSync/13_Decision_Records/`

---

## Open Build Items — Read Before Any Build Session

| ID | Item | Blocks |
|---|---|---|
| OB-07 | Confirm Velo owns UI state display logic for `member-sync-api.js` output | Sync screen Velo build |
| OB-09 | FORGE — setup wizard email input → `clients.notification_email` | Operator notifications |
| OB-19 | **Railway deployment** — set env vars, run DR-034 migration (OB-46), enter HOG real hardware API key. **REOPENED 2026-04-01 — deploy steps not yet completed.** | HOG go-live |
| OB-25 | Set `CORE_ENGINE_URL` env var on Railway Admin Hub service. Currently resolves null → empty field in onboard Step 5. | First operator onboard |
| OB-28 | Push 3 spec docs to repo: `SPEC_Operator_UI_System.md`, `SPEC_Business_Flows.md`, `SPEC_Software_Flows.md` → `docs/specs/`. | Repo parity |
| OB-34 | `member_access_widget.html` — rename "Family Member" → "Additional Member". **DEFERRED post-HOG.** | Terminology |
| OB-39 | Vault mockups (`12_UI_Mockups/`) vs live EJS templates — mark vault mockups as design reference only. | Vault accuracy |
| OB-40 | Payment collection + subscription activation. **TABLED — revisit post-HOG.** | Post-launch |
| OB-46 | **Railway migration: `CREATE TABLE member_access_sources`** (DR-034 schema). Must run before OB-47/48. | Multi-source safety |
| ~~OB-47~~ | ~~Standard Adapter `completeGrant` pre-grant source check.~~ **CLOSED 2026-04-27** — Implemented in `grant-revoke.js` (L4, where the hardware call decision lives). Queries `member_access_sources JOIN member_role_assignments`; reuses RA id if permanent row found. commit `cc4d0c2`. | ~~Multi-source safety~~ |
| ~~OB-48~~ | ~~Standard Adapter `completeRevoke` source-aware revoke.~~ **CLOSED 2026-04-29 (audit).** Implemented in `core/grant-revoke.js` `processRevoke()` — source row deleted first, remaining count checked, `removeRole` only when count = 0. DR-034 multi-source safety complete. | ~~Multi-source safety~~ |
| OB-125 | **`source_tag` guard on `deleteUser` path.** [core/grant-revoke.js:374](core/grant-revoke.js#L374) calls `hardwareAdapter.deleteUser` on `member.deleted` without checking that `member_identity.source_tag = 'accesssync'`. Risk: a `member.deleted` event for a user whose Kisi user is also an admin/staff identity would delete the Kisi user and kill non-AccessSync access. Policy: AccessSync deletes only Kisi users it created. Foreign users → remove AccessSync role assignments only, never the user itself. Discovered 2026-04-29 during Daxx-row audit. | Shared-identity safety |
| OB-49 | **Nightly reconciliation** — compare `member_access_sources` against live hardware role assignments. Flag orphans + missing. Clean expired `valid_until` rows. **PARTIAL 2026-04-26** — per-member `reconcileMember()` shipped (covers operator-triggered repair from member drawer). Global nightly version + `valid_until` cleanup remain open. | Reconciliation accuracy |
| OB-51 | Set `RESEND_API_KEY` + `RESEND_FROM_EMAIL` in Railway. Required before any alert emails fire. | Sprint 5 email alerts |
| OB-56 | Weekly summary email. **DEFERRED — 3 design decisions needed first.** | Post-sprint |
| G-10 | NOVA reviews Kisi API docs, confirms schema assumptions | Adapter build start |
| RI-01 | **PARSE research: Wix plan modification behavior.** Does Wix change `plan_id` on rename/reprice? Does archiving fire `plan.cancelled`? Load-bearing assumption — must verify before HOG launch. | HOG correctness |
| DEF-01 | Role-based Admin Hub access. **Deferred — trigger: second client onboard.** | Multi-client scale |
| OB-63 | HOG: manually set `clients.site_id` via Railway DB (`UPDATE clients SET site_id = '1a89c38a-d23a-4000-8ad3-c9b999a23dc3' WHERE name = 'House of Gains'`) | HOG portal flow |
| OB-64 | Create + install Wix Dashboard Page Extension for HOG | HOG portal flow |
| OB-65 | Build `core/subscription-manager.js` — owns all `client_subscriptions` writes | DR-036 integration |
| OB-66 | Wix billing webhook handler — operator `plan.purchased/upgraded/cancelled` → `client_subscriptions` | Automated subscription provisioning |
| OB-67 | Subscription lapse trigger — status change → `suspendLocationMembers()` | Billing integrity |
| OB-68 | Onboarding location creation — atomically create `client_subscriptions` row | New operator subscription records |
| OB-69 | Dual-read phase — COALESCE `client_subscriptions` + old columns in all 7 breaking files | Prerequisite for OB-71 |
| OB-70 | **Run `migrations/dr-036.sql` on Railway Postgres** | DR-036 schema live |
| OB-71 | Column removal — drop redundant `locations` + `plan_mappings` columns (post-validation, Phase 6) | Clean schema |
| OB-72 | Tier mapping: Wix plan ID → AccessSync tier at subscription creation time | OB-66 prerequisite |
| OB-73 | Data fix: update `plan_mappings.tier_name` from backfilled `client_subscriptions.tier` | Tier data accuracy |

Full open items: `AccessSync/open_items.md`

---

## Hard Gates — Nothing Ships Without These Closed

| Gate | Status |
|---|---|
| G-01 | Chad signed agreement | Open — pitch sent, awaiting response |
| G-02 | LLC formation | Open |
| G-03 | Kisi reseller agreement — attorney review | **CLOSED 2026-04-10 — Daxx is a Kisi partner** |
| G-04 | Wix developer account confirmed | **CLOSED 2026-04-02** |
| G-05 | Business technology insurance | Open |
| G-06 | Failure runbook complete | Open — optimistic error resolve risk must be documented |
| G-07 | Michael partnership decision | **CLOSED 2026-03-24 — No partnership. Daxx building solo.** |
| G-08 | Kisi API access confirmed from Joe | **CLOSED 2026-04-10 — Kisi partner API access confirmed** |
| G-09 | Chad confirmed on Kisi Pro tier ($199/mo/location) | **CLOSED 2026-04-10 — Chad bought Kisi** |
| G-10 | NOVA reviews Kisi API docs, confirms schema assumptions | Open — blocks adapter build start |

---

## Environment Variables Required

```
# Core Engine (Railway app service — node server.js)
DATABASE_URL                  PostgreSQL connection string (Railway)
REDIS_URL                     Railway Redis connection string (required for BullMQ)
WIX_WEBHOOK_SECRET            HMAC secret from Wix developer dashboard
PORT                          Set by Railway automatically
NODE_ENV                      development | production
RESEND_API_KEY                Resend API key (resend.com dashboard)
RESEND_FROM_EMAIL             Sender address (e.g. alerts@accesssync.io) — DR-020
ACCESSSYNC_OWNER_NOTIFICATION_EMAIL   Platform owner email (Daxx). Receives HMAC spike alerts,
                              reconciliation digests, and client notification fallback when
                              client has no notification_email set. Set once per Railway deployment.
API_KEY_ENCRYPTION_KEY        64-char hex string — AES-256-GCM for hardware + Wix API keys (DR-028).
                              Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                              Required on BOTH core engine and admin hub services — must be the same value.
DEFAULT_TENANT_ID             Temporary placeholder — remove when multi-tenant routing is complete

# Admin Hub service (Railway — node admin/server.js)
ADMIN_JWT_SECRET              Random 64-char string — JWT signing secret
GOOGLE_CLIENT_ID              OAuth 2.0 Client ID (Google Cloud Console)
ADMIN_ALLOWED_EMAIL           daxxroberts@gmail.com — only this Google account can log in
OWNER_PIN                     Owner PIN to bypass hardware key validation during onboarding
OPERATOR_INVITE_TOKEN         Gate on operator signup endpoints — fails closed if not set.
                              Generate: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
                              Operator receives link with ?invite=TOKEN
CORE_ENGINE_URL               Core Engine base URL — populates webhook URL in onboard Step 5 (OB-25 open)
WIX_APP_ID                    Wix App ID from Wix Dev dashboard — identifies this app to Wix
WIX_APP_SECRET                Wix App Secret Key — used by wix-instance.js to verify signed instance HMAC. Required for operator portal entry point. Crashes on startup if absent.
```

---

## Vault Navigation Protocol

**Read these in order before opening any other file:**

1. `00_START_HERE.md` — vault state, hard gates, critical file list
2. `00_Vault_Control/VAULT_SUBSTANCE_MAP.md` — one-line summary of every active file
3. `open_items.md` — all open blockers and decisions

**Rules:**
- Never use a file with status `stale` or `draft` as build input — check `VAULT_SUBSTANCE_MAP.md` first
- Never re-litigate a locked decision — open `13_Decision_Records/DECISION_LOG.md` first
- Never open `99_Archive/` or `01_Project_Foundation/Claude_Versions/` without explicit direction
- Never create a new file without checking `VAULT_SUBSTANCE_MAP.md` for duplicates
- KEEPER runs `00_Vault_Control/KEEPER_SESSION_CHECKLIST.md` before every session closes
- Read `00_Vault_Control/KEEPER_SESSION_OPEN_CHECKLIST.md` before any build session starts
- Hardware-touching docs require `source_reads` frontmatter (RULE-12)
- When updating any vault file, update its frontmatter: bump `last_updated` to today's date and correct `status` if changed

**Stale files — do not use as build input:**
- `03_Architecture/Event_Flow.md` — predates 7-layer architecture (DR-022)
- `03_Architecture/Service_Architecture.md` — predates 7-layer architecture (DR-022)

---

## Family Plan — Hard Stop

**⚠️ DO NOT begin any family/multi-member plan build work before HOG go-live.**

DR-029 through DR-033 are locked and ready. The `member_access_widget.html` is a Velo iframe design reference only — not deployed, no corresponding operator-side code. `members.ejs` has no family grouping code. This block will not lift until Chad confirms HOG sells family memberships.

---

## Team Protocol

This project is managed by the Business Operating Team (BOT). The vault is the single source of truth.

**Governance rules:**
- No architectural decisions without SAGE sign-off
- No vault changes without KEEPER proposal → SAGE review → Daxx approval
- NOVA never designs against memory — always reads repo and vault first
- Silence is not approval. Explicit confirmation required at every gate.
- **Vault-First Rule (ALL agents — mandatory, expanded 2026-04-27):**
  - Before asking Daxx any question, search the vault for the answer. If the vault has a clear answer, use it. If it has a partial answer, state what was found and what specifically remains unresolved. Only ask Daxx what the vault genuinely cannot answer.
  - **Before SAGE convenes the BOT team on any architectural decision, schema change, new DR, or significant feature**, KEEPER must explicitly state "vault read complete — files checked: [list]" naming every relevant vault file consulted. SAGE does not rule until this statement is made. This is a hard gate, not a polite suggestion. Process incident on 2026-04-27 (logging architecture sprint convened without vault read; Daxx caught stale `Event_Types.md` / `Error_Codes.md` mid-flight) prompted the explicit gate.
- **Agent idle exit rule:** Any automated/headless agent must exit after 3 consecutive idle polling cycles with no new tasks. Never loop indefinitely. Log a final status summary before exiting.

## BOT Team — When to Invoke

**Rule: Route first, answer second.** If a question falls into any category below, invoke the listed agent before responding from training data or searching independently. After the agent delivers findings, supplemental context is allowed.

| Trigger | Agent(s) | Rule |
|---|---|---|
| Any question about Wix API behavior, webhooks, payload shapes, or event lifecycle | PARSE | PARSE researches from official docs first. Do not answer from training data. |
| Any question about Kisi API behavior, field semantics, or hardware constraints | PARSE | Same as above. Kisi docs are frequently out of date in training data. |
| Any external platform API (Seam, Resend, Railway, BullMQ, etc.) | PARSE | Same rule. Always docs-first. |
| Any architectural decision — new table, new layer, new pattern, DR revision | SAGE | SAGE gates before any code is written. No exceptions. |
| Any schema change — new column, new table, migration | ORION + SAGE | ORION proposes, SAGE approves. Migration written only after both sign off. |
| Any vault read or write — open_items.md, CLAUDE.md, DECISION_LOG.md, any vault file | KEEPER | KEEPER owns all vault changes. Never edit vault files directly without KEEPER proposing the change. |
| Any assumption that is load-bearing for correctness | AXIOM | AXIOM tags and pressure-tests before the assumption drives build decisions. |
| Any operator-facing copy, onboarding text, or email content | LUMEN | LUMEN owns tone and messaging for operator-facing surfaces. |
| Any UI build — EJS operator pages | FORGE | FORGE builds. LENS verifies against IRIS element map before sign-off. |
| Any member-facing UI — Velo, sync widget | PIXEL | PIXEL builds. LENS verifies. |
| Any question about what's been built, what's open, or what blocks what | KEEPER | KEEPER reads the vault. Do not answer from memory or session context alone. |
| Session open — any build session | REX + KEEPER | REX gates. KEEPER runs open checklist. No build without both cleared. |
| Session close — any session where code, schema, or vault changed | KEEPER | KEEPER runs close checklist. Vault always updated before session ends. |

**Agents with direct build authority:**

| Agent | Role |
|---|---|
| SAGE | Architectural review. Unlocks DRs. Final authority on architecture decisions. |
| REX | Session gatekeeper. Enforces read-first gate. Monitors spec vs code divergence. |
| KEEPER | Vault manager. Owns all vault reads/writes. Proposes — never acts unilaterally. |
| NOVA | Core engine engineer. Builds and maintains all `core/` and `adapters/` files. |
| FORGE | Admin Hub UI engineer. Builds EJS templates and operator-facing pages. |
| PIXEL | Member-facing UI. Wix Velo iframe screens and member sync widget. |
| ORION | Database architect. Schema design, migrations, data model integrity. |
| QUILL | Technical writer. Spec authorship, doc currency, vault file corrections. |
| AXIOM | Assumption auditor. Tags and pressure-tests every `[ASSUMPTION:]` flag. |
| PARSE | External research. API verification, Wix/Kisi/Seam docs, unresolved questions. |
| LUMEN | GTM and operator messaging. Onboarding copy, email content. |
| FELIX | QA and deployment. Runs tests, confirms deploys, Railway validation. |
| SPAN | QA / Test Coverage. Reviews built features end-to-end. No build authority — review and flag only. |
| LENS | Live Site Monitor. Hits Railway endpoints, reads response data, diagnoses what's broken. No build authority — diagnostic only. |

Full team definition: `_Tools/business-operating-team.skill`

**Deferred-UI Rule (NOVA + KEEPER — mandatory):** Any UI element that defers functionality — skip buttons, "I'll do this later" actions, placeholder CTAs, or buttons linking to screens not yet confirmed to exist — MUST have a corresponding OB logged in `open_items.md` before that session closes. The OB must state: (a) what element defers the action, (b) where the completion UI lives or should live, (c) whether that screen currently exists.

---

## Pre-Commit / Pre-Push Gate

**Before any `git commit` or `git push`, run the test suite:**

```bash
npm run test:deploy
```

This runs the business-risk-aware test framework (P1/P2/P3 tiers). The output will be either `DEPLOY SAFE` or `DO NOT DEPLOY`.

- **DEPLOY SAFE** — all P1/P2/P3 tests pass. Commit or push may proceed.
- **DO NOT DEPLOY** — one or more tests failed. Do not commit or push. Fix the failing tests first, then re-run before proceeding.

**Never skip this gate.** P1 tests cover the core grant/revoke/suspend paths — a failure here means members could pay and get no access, which is a churn risk. The test run takes seconds. There is no valid reason to bypass it.

If `npm run test:deploy` is not available (e.g., Jest not installed), run `npm install` first.

---

## Session Protocol — REX Gates

**No build work begins until all three gates clear.**

**Gate 1 — KEEPER open checklist complete**
KEEPER confirms: *"Vault read complete. Ready to proceed."* REX does not allow build work until this statement is made. Full checklist in `00_Vault_Control/KEEPER_SESSION_OPEN_CHECKLIST.md`.

**Gate 2 — Scope + spec confirmed**
Name what is being built. Confirm the spec and schema files covering it are read and current. If any relevant spec is `draft` or `stale`, KEEPER corrects it before build begins. Build never proceeds against a stale spec.

**Gate 3 — Open items cleared**
Read `open_items.md`. If any hard gate or "blocks build" item covers today's planned work, surface it to Daxx. Do not begin blocked work.

**During session:**
- Spec vs code divergence is never silent — stop, correct, then continue
- DR locked mid-session → immediately identify and flag all affected specs in the same session
- Long session → context reset before starting a new module (re-read CLAUDE.md + spec + schema.sql)
- Draft/stale spec block: no build work against a spec marked `draft` or `stale`. KEEPER corrects first.

**Session close:** KEEPER runs `00_Vault_Control/KEEPER_SESSION_CHECKLIST.md` before every session closes. No exceptions.

Full REX protocol: `00_Vault_Control/REX_ACTIVE_SESSION_PROTOCOL.md`

---

## KEEPER Protocol — Session Open (MANDATORY)

**Run before every session — build, planning, documentation, or vault question. The vault is read first. It is not a fallback to consult mid-session.**

**Step 1 — Name what is happening today**
Before reading anything: what is being built? Which spec files cover it? Which tables are relevant? Which DRs apply?

**Step 2 — Read the vault**

| File | Confirm |
|---|---|
| `CLAUDE.md` Repository State | Build state matches your understanding |
| `open_items.md` | No hard gates or "blocks build" items unresolved for today's work |
| Every spec covering today's work | Status = `active` (not `draft` or `stale`) |
| `schema.sql` | Every field name you plan to use exists with the correct name |
| Relevant DR files | No DR locked since the spec was written that changed a field or decision |

**Step 3 — Flag check**

| Condition | Action |
|---|---|
| Spec covering today's work is `draft` or `stale` | Correct spec to `active` first. Build after. |
| Spec has unresolved "blocks build" open items | Surface to Daxx. Get explicit go-ahead. |
| Field name in spec doesn't match `schema.sql` | Correct the spec. Never build against wrong field names. |
| DR locked since spec was last updated changes a field the spec references | Update spec. Then build. |
| Hard gate in `open_items.md` blocks today's work | Do not begin. Notify REX and Daxx. |

**Step 4 — Confirm to REX**
> *"Vault read complete. [Any flags surfaced and resolved.] Ready to proceed."*

REX will not allow build work to begin until this statement is made.

**Stale file policy:** `stale` is a last resort — not a label for "noticed it's wrong, will fix later." When KEEPER discovers an inaccurate file, the correct action is to correct it immediately. Mark `stale` only when the file genuinely cannot be corrected because required information doesn't exist yet (waiting on a decision, an API response, a schema that hasn't been designed). Stale means "blocked on [X]."

---

## KEEPER Protocol — Session Close (MANDATORY)

**Run before every session where code, schema, decisions, or vault files changed.**

**Step 0 — Navigate first:** Read `VAULT_SUBSTANCE_MAP.md`. List every domain touched this session. For each domain, identify all vault files covering it. Those are your update targets.

| Domain touched | Vault file to update |
|---|---|
| Schema changed | `04_Data/Data_Model.md` |
| Architecture changed | `03_Architecture/System_Architecture.md` |
| Decision locked | `13_Decision_Records/DECISION_LOG.md` + DR file |
| Integration changed | relevant `05_Integrations/` file |
| New env var | CLAUDE.md env var section |

**Always check and update:**

| File | Action |
|---|---|
| `changelog.md` | Append session entry — what changed, what was decided, what was built |
| `KB_FILE_REGISTRY.md` | Add new files; update status of changed files |
| `VAULT_SUBSTANCE_MAP.md` | Add summaries for new files; update stale descriptions |
| `open_items.md` | Capture new blockers or decisions surfaced this session |
| `CLAUDE.md` | Bump version + update Repository State if build progress was made |
| Deferred-UI check | Every skip/placeholder CTA added this session has a corresponding OB in `open_items.md` |
| Frontmatter | On every vault file updated this session: bump `last_updated` to today's date. Update `status` if state changed (e.g., `draft` → `active`, `active` → `stale`). If the file has no `last_updated` field, add one. |

**Fast path (Daxx approval only — no SAGE required):** Adding entries to registries, appending to changelog, adding to open_items.md, bumping CLAUDE.md for build state changes.

**Full workflow still required for:** structural vault changes, locked decision changes, CLAUDE.md changes that affect architecture or locked decisions.

**Rule: KEEPER proposes, Daxx approves. Silence is not approval.**

---

## Knowledge Base

**Vault location:**
`C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync`

**Repo location:**
`C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync GitHub\accesssync`

**Vault version:** 2.0.0 (as of 2026-04-03)
**Start here:** `AccessSync/00_START_HERE.md`
**Open items:** `AccessSync/open_items.md`
**Decisions:** `AccessSync/13_Decision_Records/DECISION_LOG.md`
**Data model:** `AccessSync/04_Data/Data_Model.md`
**Integration specs:** `AccessSync/05_Integrations/`
**Hardware API reference:** `AccessSync/_Tools/kisi-api.llms.txt`

---

## CLAUDE.md Version History

| Version | Date | Summary |
|---|---|---|
| v1.0–v1.9 | 2026-03-07 to 2026-03-26 | Initial setup through Phase 2+3 complete. V1 code-complete. DR-020/021 locked. |
| v2.0–v2.9 | 2026-03-27 to 2026-03-28 | Admin Hub built + deployed. 7-layer architecture (DR-022–025). OB-12/14 closed. DR-026 locked. |
| v3.0–v3.2 | 2026-03-28 to 2026-03-29 | DR-027/028 locked. Per-location subscription + encrypted API key storage. OB-03-A/08/20/05 closed. |
| v3.3–v3.6 | 2026-03-29 to 2026-03-31 | Onboarding wizard. Deferred-UI rule. Owner bypass PIN. EJS refactor (6 pages). |
| v3.7–v3.9 | 2026-04-01 | All 4 project-plan sprints complete. Sprint 5 hardening (DR-035, HMAC monitor, health check, CSV export, first grant email). Business-risk test framework. |
| v4.0 | 2026-04-02 | AI-forward knowledge base complete. 8 docs, llms-full.txt. DR-035 + sprint-5 migrations applied and confirmed. |
| v4.1 | 2026-04-06 | Merged v4.0 (repo) with vault state corrections: platform-agnostic product description; DR-029–034 added to locked decisions; OB-19 corrected to REOPENED; G-04 closed; REDIS_URL + CORE_ENGINE_URL added to env vars; new open items OB-25/28/34/39/40/46–49/51/56/RI-01/DEF-01 added; DR-014 color values corrected to match DECISION_LOG (#4F6EF7/#4ADE80); schema count clarified (13 in DB, 14 when OB-46 runs); SPAN/LENS agents added to team table. |
| v4.2 | 2026-04-06 | Added Pre-Commit / Pre-Push Gate — `npm run test:deploy` required before every commit or push. DEPLOY SAFE / DO NOT DEPLOY verdict gates all code merges. |
| v4.3 | 2026-04-06 | Frontmatter update rule added — KEEPER must bump `last_updated` and correct `status` on every vault file touched in a session. Rule appears in both KEEPER Session Close table and Vault Navigation Protocol. |
| v4.4 | 2026-04-08 | Operator portal feature. New: `wix-instance.js`, `portal.js` (setup detection), `portal-setup.ejs`, `onboard.ejs` (invite token server-side injection). Deleted: `onboard.html`. Auth.js updated: `signOperatorToken`, `requireAuthPageOrOperator`. Server.js: portal routes mounted, operator pages migrated to `requireAuthPageOrOperator`. `WIX_APP_SECRET` + `WIX_APP_ID` added to env vars. OB-63/64 added. |
| v4.5 | 2026-04-08 | Portal new-operator redirect. `wix-instance.js` no-client-found → redirect to `/onboard?siteId=<instanceId>` instead of 403. `/onboard` auth gate removed. `onboard.ejs`: siteId URL param pre-fill, `siteIdVerified` flag, Test required before Next on manual path. `allowWixFrame` middleware added to server.js. OB-63 updated with HOG instanceId and manual DB fix. |
| v4.6 | 2026-04-10 | Synced with repo v4.3. G-03/G-08/G-09 closed. `KISI_ENCRYPTION_KEY` corrected to `API_KEY_ENCRYPTION_KEY`. Wix Bookings API updated to V2 query pattern (`/_api/bookings/v2/services/query`). |
| v4.7 | 2026-04-13 | DR-036 locked — `client_subscriptions` table (platform-agnostic billing model). `tier_subscription_id` FK on `locations`. Supersedes `locations.tier`, `locations.subscription_status`, `locations.subscription_id`, `plan_mappings.tier_name`. Full codebase audit: 7 hard-breaking files identified, 3 missing code paths, 4 business flow gaps. 6-phase migration plan. `migrations/dr-036.sql` written (Phase 1 — additive only). OB-65–OB-73 added to open_items.md. Schema count updated to 15 tables (13 live, 2 pending migration). |
| v4.8 | 2026-04-17 | **Full-session output after member 7af07f2c audit + BOT review.** Three PRs pushed green, SAGE-approved for merge: (1) `ob-88-tenant-resolver-fix` — classifies tenant-resolution failures into `events_js_outdated`/`unknown_site_id`/`unknown_client_id` with diagnostic context, distinct `config_alert_log.alert_type` values, `diagnostic_log` persistence via warn→error upgrade; (2) `ob-89-qualified-request-gate` — two-gate design shipped (Gate 1 validator in Layer 5 `hardware-adapter.js` throws `INVALID_HARDWARE_REQUEST`; Gate 2 recovery orchestrator in Layer 3 `standard-adapter.js` runs ladder via Wix Members API → DB cache → park `pending_identity`), plus new `adapters/wix/wix-members-api.js` client, new `pending_identity` status value; (3) `standards-register-and-guardrails` — new `AccessSync/STANDARDS.md` living pattern register (5 sections, 7 seed entries), mandatory CLAUDE.md Standards Register Protocol, new `core/rate-limiter.js` shared sliding-window helper wired into both Wix API clients at 10 req/sec, `@users.wix.com` synthetic email rejection in Wix Members API (with fix for Option D ordering bug), new P3 tests `no-raw-console.test.js` + `rate-limiter.test.js` + `wix-members-api-normalization.test.js`. Tests: 80/80 DEPLOY SAFE across 10 suites. OB-85/86/87 shipped. OB-88 shipped on branch (operational OB-93 follow-up required). OB-89 shipped on branch. OB-90 partially shipped in queue-worker; follow-up remaining. DR-001-A proposed (email caching amendment) with four SAGE-gated conditions: VERA slippery-slope clause, OB-95 (member-deleted cascade to email), OB-96 (Admin Hub endpoint audit), OB-97 (log-context lint extension). OB-91 fully spec'd (Kisi error self-healing loop) with 7 locked decisions — not yet built. OB-94 (member email capture form) de-prioritized after Builder empirically confirmed Google + Facebook social logins pass real emails via OAuth consent scope. New vault files: `AccessSync/STANDARDS.md`, `AccessSync/grant-flow-with-obs.html` (diagram of all four OBs). Builder directive captured: diagnostic-context-at-connector-boundaries pattern is reusable for all future connectors. |

| v4.9 | 2026-04-24 | Four production fixes across 4 commits after first confirmed HOG member grant (Couples plan, 2026-04-23): (1) `f883cc8` — `wix-adapter.js` + `onboard.ejs`: `orderAutoRenewCanceled`/`orderEnded` now map to `plan.cancelled`; two new Velo handler exports added to EVENTS_JS_TEMPLATE. (2) `d10a69d` — `dashboard.ejs` + `operator.js`: Wix chip pill conditioned on real `last_webhook_at` column (was hardcoded green), site label falls back to `source_site_name`, plan mapping disambiguates duplicate names by showing last 6 chars of `source_plan_id`, locations query COALESCEs `hardware_platform` from client row. (3) `d41a25e` — `grant-revoke.js` + `grant-retry-idempotency.test.js`: `newHardwareCallMade` flag gates `member_access_log` INSERT to real hardware calls — eliminates duplicate `provisioned` entries from Wix triple-fire purchase events. (4) `3b2def8` — `member-sync-api.js`: fixed 500 on every `/member/access-status` call — `rolesResult` query referenced non-existent `mra.hardware_role_id` and `mra.status = 'active'` columns. Column name corrected from `last_wix_webhook_at` to `last_webhook_at` throughout vault. |

| v4.10 | 2026-04-26 | Per-member reconcile (OB-49 partial close). New `core/reconciliation.js#reconcileMember(memberId, clientId)` — full live Wix + live Kisi + DB-row diff for one member. Detects DB drift in `member_role_assignments`/`member_access_sources` (the gap that surfaces "no hardware role assignment" after a plan-mapping edit). Surfaces 4 integrity classes to operator (`no_mapping_for_plan`, `mapping_missing_group`, `duplicate_mappings_for_plan`, `untraceable_hardware_access`) — never auto-fixes. Repairs flow through L3 via synthetic `plan.purchased` events (DR-023 boundary preserved; `completeGrant` ON CONFLICT DO NOTHING + Kisi idempotent assignRole make this safe). New endpoint `POST /operator/:clientId/members/:memberId/sync`. New "Reconcile Member" button + humanized result panel in member drawer ([admin/views/pages/members.ejs](../AccessSync GitHub/accesssync/admin/views/pages/members.ejs)). STANDARDS.md entry added: "Per-entity reconciliation that detects DB drift without bypassing L3". Tests: 90/90 DEPLOY SAFE across 11 suites. |

| v4.11 | 2026-04-27 | Member Hub redesign + DR collision resolved + production bug fix. (1) Pushed the full Member Hub iframe redesign (`admin/views/pages/multi-member.ejs`, +1421/-522) — visual + UX refresh, sticky CTA, refined empty/loading/error states, Toast.svelte wired into operator dashboard via new `#svelte-toast` outlet. ClientsPanel button relabeled "+ New Client" → "Generate invite link" (commit `9d479a3`). (2) Caught and fixed a 500 on `POST /api/multi-member/members` — the INSERT into `member_identity` had `$10` placeholder with only 9 args bound, blocking sub-member adds on the live Member Hub. One-line fix removed the extra placeholder so the literal `'draft'` lands in `sub_member_status`. Tests: 90/90 DEPLOY SAFE (commit `adb160f`). (3) Resolved DR number collision: the per-plan sub-member assignment work (shipped 2026-04-26 in commit `21a9233`) had grabbed DR-037 informally; the Logging Foundation Sprint formally proposed DR-037/038/039 (Observability Architecture, Event Registry, Redaction Allowlist) on 2026-04-27. Sub-member yields the lower number to the formal proposal. Renumbered to **DR-040** across `migrations/dr-037.sql` → `migrations/dr-040.sql` (git mv preserves history) plus 11 inline DR references in `schema.sql`, `admin/routes/multi-member.js`, `admin/views/pages/member-hub.ejs` (commit `12ff02a`). New vault file `13_Decision_Records/DR-040_Per_Plan_Sub_Member_Assignment.md` written and locked; DECISION_LOG row added; CLAUDE.md locked-decisions table updated. |
| v4.12 | 2026-04-27 | OB-47 pre-grant source check + Logging Sprint Steps 7-12. (1) OB-47 closed — `core/grant-revoke.js` `processGrant()` mapping loop now opens with a source check against `member_access_sources JOIN member_role_assignments`; if permanent access exists the hardware call is skipped and the prior `role_assignment_id` is reused (DR-034 multi-source safety complete). (2) `admin/middleware/activity.js` — new `recordActivity(req, event, ctx)` fire-and-forget helper: inserts to `activity_event` table, actor+traceId from AsyncLocalStorage, uses `setImmediate` to never block response path, DB failures written to stdout only. (3) `core/EVENT_REGISTRY.md` — full log-event taxonomy (~50 events, 11 namespaces) governing DR-038; new `grant.role.source_exists` event from OB-47 included. (4) `core/redaction-allowlist.json` — three-section allowlist (always_safe ~60 fields, never_log ~20 fields, redact_if_pattern_matches PII) governing DR-039. (5) `recordActivity()` wired into 7 mutation routes in `admin/routes/operator.js`. (6) `test/p1-critical-path/grant-retry-idempotency.test.js` — mock sequences updated for all 4 tests to account for new OB-47 source check `db.query()` call. Tests: 258/258 DEPLOY SAFE. commit `cc4d0c2`. |
| v4.13 | 2026-04-27 | Members Page v2 — React/Babel island. (1) `admin/views/pages/members.ejs` replaced with thin EJS shell (topbar/subnav partials + `<div id="root">` + script load order + inline CSS verbatim from prototype). Server-injects `window.__CLIENT_ID` from `req.admin.clientId`. (2) `admin/public/members-bridge.js` (new) — API adapter: `shapeMember()` flat snake_case → nested camelCase; `mapStatus()`/`mapAccessStatus()` translate `effective_status` enum to prototype's 4-state enum; `buildMembersArray()` separates holders from subs via `plan_holder_id` and nests subs as `additional[]`; `attachErrors()` cross-references `/operator/:clientId/error-summary`; `loadMembers()` fans out 3 parallel fetches and fires `membersLoaded` event. `clientId` resolution: `window.__CLIENT_ID` → meta → body attr → URL param. (3) `admin/public/members-app.jsx`, `members-data.jsx`, `members-parts.jsx`, `members-icons.jsx`, `tweaks-panel.jsx` (new) — React 18 + Babel-standalone components from prototype. App converted from `MEMBERS` global → `members` React state with `useEffect` listener for `membersLoaded`. All 5 useMemo dep arrays fixed (FELIX caught the stale-cache bug introduced by the global → state conversion). Hardcoded "Northpoint Athletic" breadcrumb + "synced 2 min ago" subtitle wired to `pageContext` from bridge. Fake "↑12 vs last month" deltas dropped. "Door entries · today" set to `—` (OB-110). (4) `admin/server.js` — `/members` render passes `clientId` to EJS context. **Stack note:** introduces React + Babel-standalone as a third frontend stack alongside Svelte (Owner Dashboard) and EJS+vanilla-JS (other 5 operator pages). SAGE approved Path 1 (React island, ship now) over Path 2 (Svelte port) explicitly to honor "do not change how it looks" and avoid HOG launch delay. Tests: 258/258 DEPLOY SAFE. commit `0da2d1f`. New OBs: OB-109 (post-HOG Svelte port), OB-110 (door-entries stat), OB-111 (MoM delta), OB-112 (plan rate field caching). |
| v4.14 | 2026-04-28 | Sprint 6 (Trace Timeline UI) scoped — no code shipped, planning + Sprint plan only. BOT review of Daxx-delivered Admin Log UI prototype (Admin Log UI.html + 7 JSX/CSS support files; React 18 + Babel-standalone, design-canvas wrapper). Convened: SAGE, NOVA, FORGE, AXIOM, FAULT, REED, LENS, REX. Decisions: (a) MVP audience = Daxx-only — Chad operator self-serve deferred 30 days post-HOG (OB-113); (b) navigation = existing topbar subnav + new "Logs" tab — prototype's left Sidebar dropped; (c) source color palette approved in concept — DR-014 amendment drafted by FORGE in Phase 3, signed by SAGE (OB-116); (d) drops from prototype: WindowChrome, DesignCanvas, TweaksPanel, Sidebar; (e) drawer view technical-only regardless of voice toggle (NOVA + FAULT safety design). 5-phase plan, ~8.5 dev days, single owner per phase, gated NOVA → FELIX `test:deploy` DEPLOY SAFE → SAGE final review. **Drift discovered during KEEPER session-close audit:** `migrations/dr-041.sql` exists on disk (creates `trace_context` + rebuilds `v_trace_timeline` with enriched JOIN); DECISION_LOG ends at DR-040; CLAUDE.md does not list DR-041; no vault evidence of Railway apply — logged as OB-120, prerequisite for Phase 1. Initial review proposed enumerating event vocabulary as a Phase 1 deliverable; audit revealed `core/EVENT_REGISTRY.md` already exists (DR-038, ~50 events across 11 namespaces) — Phase 1 work reduced to "gap-fill `humanize()` against EVENT_REGISTRY." 8 OBs filed: OB-113 (Chad audience deferred), OB-114 (live streaming deferred), OB-115 (real sparkline endpoint), OB-116 (DR-014 source-color amendment), OB-117 (untraced-event volume quantification), OB-118 (retry-count + still-failing indicator), OB-119 (stack consolidation tracking — linked to OB-109), OB-120 (dr-041 deployment verification). Build authorization for Phase 1: pending Daxx green-light on prerequisites. |
| v4.15 | 2026-04-28 | Sprint 6 Phase 1 shipped — trace plumbing fix. Phase 1 audit against Railway prod found null-trace_id rates of 92–100% across 5 of 7 log tables (webhook_log 94%, diagnostic_log 92%, member_access_log 100%, error_queue 100%, config_alert_log 100%). All 1,865 trace_context rows were anonymous health-check pings with NULL client_name/member_name/plan_name. Root cause: 14 INSERTs across 8 files omitted `trace_id` from column lists; entry-point middleware never enriched trace_context after member/plan resolution mid-request. **Fix shipped — commit `d434b91`, pushed to `origin/main`, Railway redeploy confirmed:** new `setTraceContext(traceId, opts)` helper in `core/trace-context.js` (UPDATE-with-COALESCE, fire-and-forget), 14 INSERT call sites updated to thread `trace_id, actor_type, actor_id` from `getTraceId()`/`getActor()` (grant-revoke ×5, retry-engine ×2, webhook-processor, location-lapse, plan-mapping-resolver, reconciliation ×4, operator.js, clients.js, audit.js — middleware affects all callers), `setTraceContext` enrichment wired into 4 sites (standard-adapter resolveAndLock for memberId, plan-mapping-resolver for plan/door/mapping, webhook-processor for clientId backfill, queue-worker replacing no-op `registerTrace`), `reconciliation.reconcileMember` body wrapped in `runWith`. New P3 regression test `test/p3-data-integrity/log-table-trace-id.test.js` scans core/adapters/admin for any INSERT INTO log table without trace_id — fails deploy gate before regression can recur. Tests: 259/259 DEPLOY SAFE. `handoff/QUERY_PATTERNS.md` extended with patterns N.1–N.6 covering events feed, typeahead with FAULT.2 untraced-payload fallback, full trace by ID, source breakdown, write rule (DR-037 enforcement), `setTraceContext` UPDATE pattern. Includes EXPLAIN ANALYZE notes (0.4ms on 1,865 trace_context rows + 360 log rows) and volume thresholds. **OB-117 CLOSED** (untraced-event quantification → root cause identified + fixed). **OB-120 PARTIAL** (deployment verified live; DR-041 retroactive lock in DECISION_LOG still pending). Sprint 6 Phase 2 (server endpoints `GET /admin/logs/events`, `/typeahead`, `/trace/:id`) unblocked. Limitation: 332 historical log rows remain `trace_id = NULL` and stay invisible to `v_trace_timeline` — acceptable, no backfill warranted. |

| v4.16 | 2026-04-29 | OB-48 closed (audit) + OB-125 logged. Daxx-row identity audit revealed: (1) OB-48 was implemented in `core/grant-revoke.js processRevoke()` — source row deleted first, remaining-count check, `removeRole` only when count=0; CLAUDE.md was stale. Updated open-build-items table, L3 description line, DR-034 status. (2) New OB-125 — `source_tag` guard missing on `deleteUser` path ([core/grant-revoke.js:374](core/grant-revoke.js#L374)). `case 'member.deleted'` calls `hardwareAdapter.deleteUser` without checking `member_identity.source_tag = 'accesssync'`. Risk: a `member.deleted` event for a user whose Kisi user is shared with an admin role would delete the admin's Kisi user. Policy locked: AccessSync deletes only Kisi users it created; foreign users get only their AccessSync role assignments removed. Also removed 1 orphan `member_identity` + `member_access_state` pair on the AccessSync side only (HOG: `drewbentonroberts@gmail.com`, platform_member_id `f98bdcf3-...`, status=revoked, duplicate of Drew's `###as002` sub-member). Kisi user `100560021` left untouched (still active for sub-member). |

| v4.17 | 2026-05-05 | Deployment Environment section updated: hardcoded Railway Postgres public URL directly into CLAUDE.md (postgresql://postgres:...@gondola.proxy.rlwy.net:27298/railway). Removed instruction to look up DATABASE_PUBLIC_URL via `railway variables` — CLI is not always linked. Added Node.js `pg` client as the standard pattern for migrations and dry-runs (psql not reliably on PATH). Corrected deploy method: `git commit + git push` → Railway auto-deploys from GitHub (was incorrectly showing `railway up`). |

*Archive of prior versions: `01_Project_Foundation/Claude_Versions/`*
