# CLAUDE.md — AccessSync
**Version:** 4.5 | **Updated:** 2026-04-20 | **Author:** Daxx Roberts / KEEPER

> **Read this file before writing a single line of code. Then read `open_items.md`. Then read the spec for what you're building.**

> **API/Platform Research Rule:** If a question requires knowledge of Wix APIs, Kisi APIs, or any external platform behavior — route to PARSE and the BOT team first. Do not answer from training data or search independently until PARSE has weighed in. After PARSE delivers findings, you may supplement with web search or additional context.

> **SAGE Approval Rule:** Before implementing any non-trivial change — new feature, architecture decision, schema change, UI redesign, or anything with cross-cutting impact — invoke the business-operating-team skill and pull SAGE for approval. SAGE determines which additional agents are needed to best vet the change (NOVA for engineering, ORION for schema, ATLAS for architecture, FAULT for risk, etc.). If SAGE determines the change is UX or UI in nature, bring in FORGE, LENS, PIXEL, REAM, and any other relevant design agents without hesitation. Do not proceed with implementation until SAGE has explicitly approved. Bug fixes and purely mechanical changes (typos, config values, log message wording) are exempt.

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

**All 4 project-plan sprints complete. Business-risk-aware test framework live (Concept #6): 32 tests across P1/P2/P3 tiers, custom Jest reporter + sequencer. `npm run test:deploy` gives DEPLOY SAFE / DO NOT DEPLOY verdict. End-to-end provisioning pipeline working. Member-facing sync status page live. Operator console wired to live data. Onboarding hardened with invite token auth, end-to-end validation step, and location auto-activation. Sprint 5 complete as of 2026-04-02. 6 operator UI screens live. Pre-HOG code gaps closed 2026-04-10: retryPendingHardwareMembers scoped to plan mapping save (WIRE-G-01), all platform-specific "Kisi app" copy replaced (U-09), full Humanizer pass on all 6 operator UI screens + onboarding portal. OB-46 Railway migration complete 2026-04-10 (member_access_sources table live). Business gates closed 2026-04-10: G-03 (Kisi partner), G-08 (Kisi API access), G-09 (Chad bought Kisi). Pending: G-01 (Chad agreement), G-02 (LLC), G-05 (insurance), G-06 (failure runbook), OB-47/48 (multi-source grant/revoke logic).**

**Current status as of 2026-04-10:**
- `schema.sql` — DR-018 through DR-035 applied. **14 tables in Railway DB as of 2026-04-18 (OB-46 applied — `member_access_sources` created in prod with 3 indexes).** `member_role_assignments` (DR-026), `access_type` on `plan_mappings` (DR-026), `hardware_api_key` columns (DR-035), `source_plan_id` (DR-035), `hardware_key_last_verified` + `hardware_key_last_error` on `locations` (sprint-5), `first_grant_sent` on `clients` (sprint-5).
- `db.js` — ✅ Built. pg pool, query helper, `getClient()`, `healthCheck()`, `pool` exported.
- `adapters/wix/wix-connector.js` — ✅ Layer 1. HTTP handler, HMAC verification (uses `req.rawBody`). Reads `X-AccessSync-Client-Id` header → calls `tenantResolver.registerSiteId()` for self-registration. Calls wix-adapter.parseEvent(). On HMAC rejection: calls `hmacMonitor.recordFailure()` (Sprint 5.1).
- `adapters/wix/wix-adapter.js` — ✅ Layer 2. Wix payload parsing only. parseEvent() → standard event object. Zero dependencies. Multi-path resolution for memberId + planId across Pricing Plans, Bookings, and Members event structures (P6 fix).
- `adapters/standard-adapter.js` — ✅ Layer 3. Owns member_identity, member_access_state, member_access_sources (DR-034), in_flight lock (DR-023). resolveAndLock(), resolveIdentity(), completeGrant() (pre-grant source check), completeRevoke() (source-count check), releaseLock(). Writes client_activity_summary (DR-024). `_maybeFireFirstGrantEmail()` — atomic first-grant welcome email per client (Sprint 5.5). **Note: completeGrant/completeRevoke source-check logic pending OB-47/48.**
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
- `core/grant-revoke.js` — ✅ Built. `processGrant` loops all mappings[], returns `assignments[]`. `processRevoke` loops all `roleAssignmentIds[]`. Identity/lock/state owned by Standard Adapter (DR-023).
- `core/retry-engine.js` — ✅ Built. `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/reconciliation.js` — ✅ Built. Calls hardwareAdapter.getLocks(). Stale lock cleanup, failed job re-queue, operator digest. Pending OB-49 update for member_access_sources.
- `core/member-sync-api.js` — ✅ Built. RS256 JWT verification live (OB-08 closed). Returns enriched access array: plan names, door names, location info (OB-06 enrichment).
- `core/location-lapse.js` — ✅ Built (OB-20). `suspendLocationMembers()` — suspends all active members at a location when subscription lapses. Admin routes: POST /admin/clients/:id/locations/:locationId/suspend + /activate.
- `core/crypto-utils.js` — ✅ Built. AES-256-GCM encrypt/decrypt for `hardware_api_key` + `wix_api_key` (DR-028).
- `core/wix-plans-api.js` — ✅ Built (OB-62). Wix REST API client. Authorization: bare API key in header, `wix-site-id` header. Required permissions: Pricing Plans + Bookings read.
- `admin/server.js` — ✅ Built. Separate Express app. Crash-isolated from Core Engine. EJS view engine (`admin/views/`). 6 operator page routes: `/dashboard`, `/members`, `/plan-mapping`, `/access`, `/locations`, `/admin-panel`. Passes `activeTab` to subnav partial.
- `admin/middleware/auth.js` — ✅ Built. JWT httpOnly cookie.
- `admin/routes/auth.js` — ✅ Built. Google OAuth.
- `admin/routes/errors.js` — ✅ Built. Full Error Queue CRUD + BullMQ retry.
- `admin/routes/members.js` — ✅ Built. Debug Center — search (email detection → Wix Members API resolve → ILIKE fallback), timeline, retry.
- `admin/routes/webhooks.js` — ✅ Built. Webhook Inspector — recent + detail.
- `admin/routes/queue.js` — ✅ Built. Queue Monitor — counts + jobs by state.
- `admin/routes/clients.js` — ✅ Built. Clients panel — GET / (with member counts), PATCH /:id. GET /:id/api-key/test (validates stored key against Kisi GET /groups?limit=1).
- `admin/routes/operator.js` — ✅ Built. Structured front matter (`@file/@layer/@reads/@writes/@calls/@exports/@dr`). Structured logger (`core/logger.js`) on all paths — no raw `console.*`. Error responses hardened (generic 500s, no `err.message` leaks). POST /operator/verify-bypass (owner PIN). Signup endpoints protected by `requireInviteToken` middleware + 5 req/IP/min rate limiter (OB-24). Full operator API: paginated members, config alerts, error summary, location management, hardware API key management, notification email (Sprint 5.3), onboarding, hardware groups, access log, access stats, plan mappings. Invite token middleware on signup endpoints.
- `admin/views/pages/dashboard.ejs` — ✅ Live data. Amber "Connect your hardware API key" banner when key missing (OB-26). Hardware platform chip shows amber "No Key" pill.
- `admin/views/pages/members.ejs` — ✅ Live data. Email search + CSV export (Sprint 5.6). No family grouping code.
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
- `admin/public/onboard.html` — ✅ Multi-step onboarding. Invite token gate. Owner bypass PIN path. System Check panel (`runValidation()`). Webhook secret instructions. Hardware group summary after key validation.
- `docs/what-is-accesssync.html` — ✅ Operator-facing explainer — platform boxes, 4-step flow, before/after, pricing tiers.
- `docs/architecture.html` — ✅ 7-layer architecture explainer — layer stack, standard event contract, hardware interface, adapter growth matrix.
- `docs/endpoints.html` — ✅ All 77 API endpoints across Core Engine and Admin Hub.
- `docs/index.html` — ✅ KB hub page — nav to all 8 docs, project status, sprint summary, hard gates table.
- `docs/data-model.html` — ✅ All 14 tables, column-level detail, layer ownership badges, DR chips.
- `docs/decision-log.html` — ✅ All 35 DRs as lockable cards grouped by domain.
- `docs/feature-map.html` — ✅ 38 features across 5 categories.
- `docs/operations.html` — ✅ All env vars, Railway services, migration order, pre-deploy checklist, hard gates.
- `llms-full.txt` — ✅ Full context dump — all 8 doc sections concatenated, markup stripped. ~400 lines.
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

**14 tables in Railway DB as of 2026-04-18 (OB-46 applied). All migrations through DR-035 + sprint-5.sql + multi-group-archive-audit.sql + OB-46 `member_access_sources` applied. See `04_Data/Data_Model.md` for full schema.**

| Table | Purpose |
|---|---|
| `clients` | One row per operator account. `hardware_api_key` (encrypted, DR-028/DR-035), `notification_email`, `first_grant_sent`, `last_wix_webhook_at`, `wix_api_key` (encrypted). |
| `locations` | One row per physical location. `subscription_status`, `tier`, `hardware_api_key` (per-location override), `hardware_key_last_verified`, `hardware_key_last_error` (sprint-5, DR-035). |
| `plan_mappings` | Maps `source_plan_id` (DR-035, was `wix_plan_id`) to location. `access_type`, `plan_name`, `door_name`, `status`. Multi-group via junction table. |
| `member_identity` | Platform-agnostic member record. `platform_member_id`, `source_platform`, `hardware_platform`, `hardware_user_id`. |
| `member_access_state` | Current access state per member. `in_flight` lock (DR-023). |
| `member_access_sources` | Multi-source grant/revoke (DR-034). One row per member-per-mapping-per-source. **Applied 2026-04-18 (OB-46 closed). Schema + 3 indexes live in Railway DB.** |
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

## Standards Register Protocol — MANDATORY

`AccessSync/STANDARDS.md` is the living log of proven patterns across five domains: AI, logging, user experience, authentication, best practices. It is **append-only during capture phase** — distillation into formal specs happens after enough entries accumulate.

**Before any session starts building:** read the sections of STANDARDS.md relevant to what you're about to change. If you're touching a connector, read the Logging and Best Practices sections. If you're touching auth, read Authentication. If you're touching an operator-facing screen, read User Experience. This is non-negotiable — the standards are there specifically so new work doesn't have to re-derive patterns that already exist.

**Before any session closes:** if you shipped a pattern that is worth repeating, add an entry to STANDARDS.md. Entry format is in the file header. Add it under the domain that fits best. If the pattern spans domains, pick the primary one and cross-reference.

**When to add an entry:**
- A new pattern proved itself in production (at least one real implementation in the repo).
- You chose a non-obvious path and the reasoning will be forgotten in three months.
- You made a decision that future work should follow rather than re-decide.

**When NOT to add an entry:**
- A speculative "here's what we might do." Wait for real code.
- A minor style preference with no functional impact.
- A duplicate of an existing entry — extend the existing one instead.

**KEEPER gate:** on session close, if code changed in `core/` or `adapters/` and no corresponding STANDARDS.md entry exists, KEEPER flags the session as incomplete and asks the Builder whether an entry is warranted. Silence is not approval — explicit "no entry needed" is the close condition.

**Enforcement gate:** the patterns marked as enforced in STANDARDS.md have corresponding tests in `test/p3-data-integrity/`. Example: "Never use raw `console.*`" has `no-raw-console.test.js`. When a future pattern becomes enforceable, add the test alongside the entry — mechanical enforcement is what keeps the standard from decaying.

---

## Front Matter Protocol

Every file in `core/` and `admin/views/` has a front matter comment block at the top. JS files use `/** @tag */`, EJS files use `<%# @tag %>`.

**When reading files:** Read the front matter first (first ~12 lines) before reading the body. Tags:
- `@file` — filename
- `@layer` — subsystem (`core/layer4`, `admin/pages`, `admin/partials`, `core/shared`)
- `@role` — what the file does (`provisioning`, `encryption`, `cron-nightly`, `system-config`, etc.)
- `@reads` / `@writes` — DB tables and external services touched
- `@calls` — adapters or services this file depends on
- `@exports` — what the module surfaces
- `@route` — URL served (EJS pages only)
- `@data` — API endpoints the page consumes (EJS pages only)
- `@dr` — locked Decision Records that govern this file
- `@status` — flags deferred or mock files (`skip reading body if status is deferred`)

Use tags to locate the right file before reading its body. Examples:
- `grep "@reads locations"` → every file that queries the locations table
- `grep "@role encryption"` → crypto-utils.js
- `grep "@route /members"` → members.ejs

**When modifying files:** Update the front matter to stay accurate:
- New table queried → add to `@reads` or `@writes`
- New function exported → add to `@exports`
- Route changed → update `@route`
- File goes from deferred to live → remove or update `@status`

Front matter is the index. If it drifts from reality it defeats the purpose — update it in the same edit as the code change.

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
| DR-025 | `locations` table. `clients`: +site_url, +last_wix_webhook_at. `plan_mappings`: +location_id, +plan_name, +door_name, +status. |
| DR-026 | Multi-door provisioning — `member_role_assignments` table. `payment.recovered` = enableAccess only. `UnrecoverableError` for non-retryable 4xx. Legacy fallback: `member_access_state.role_assignment_id` if `member_role_assignments` empty. |
| DR-027 | Per-location subscription model. `plan-mapping-resolver.js` filters `subscription_status = 'active'` locations. |
| DR-028 | Hardware API key storage — `clients.hardware_api_key` (org default, encrypted) + `locations.hardware_api_key` (nullable override). AES-256-GCM via `core/crypto-utils.js` + `API_KEY_ENCRYPTION_KEY` env var. Lookup: location key \|\| client key. `KISI_API_KEY_MOCK` removed (OB-23 closed). |
| DR-029 | Sub-member ID format — `{wix_uuid}###as{NNN}`. **⚠️ DEFERRED — family plan build post-HOG.** |
| DR-030 | `plan_holder_id` on `member_identity` + `member_access_state`. NULL for single/booking members. **⚠️ DEFERRED.** |
| DR-031 | Upstream explosion pattern — family events exploded in Layer 2. Core Engine unchanged. **⚠️ DEFERRED.** |
| DR-032 | Family plan draft→submit workflow. No provisioning until submit. **⚠️ DEFERRED.** |
| DR-033 | Unified member access widget — single HTML, 3 modes via `planType`. **⚠️ DEFERRED.** |
| DR-034 | `member_access_sources` — multi-source grant/revoke. Pre-grant source check. Revoke fires hardware DELETE only when all sources gone. **OB-46/47/48 pending.** |
| DR-035 | Platform-agnostic column renames: `kisi_api_key → hardware_api_key`, `wix_plan_id → source_plan_id`, `hardware_key_last_verified`, `hardware_key_last_error`. Migration applied 2026-04-02. |

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
| ~~OB-46~~ | ~~Railway migration: `CREATE TABLE member_access_sources`~~ **CLOSED 2026-04-18** — applied against prod with 3 indexes (uq_member_access_sources_identity, idx_member_access_sources_member_group, idx_member_access_sources_member). Backfilled row for HOG member `7af07f2c`. | ~~Multi-source safety~~ |
| OB-47 | **Standard Adapter `completeGrant`** — pre-grant source check. Skip hardware call if permanent access exists. Insert source row. | Multi-source safety |
| OB-48 | **Standard Adapter `completeRevoke`** — delete source row first, check remaining sources, only hardware DELETE if none remain. Wrap in transaction. | Multi-source safety |
| OB-49 | **Nightly reconciliation** — compare `member_access_sources` against live hardware role assignments. Flag orphans + missing. Clean expired `valid_until` rows. | Reconciliation accuracy |
| OB-51 | Set `RESEND_API_KEY` + `RESEND_FROM_EMAIL` in Railway. Required before any alert emails fire. | Sprint 5 email alerts |
| OB-56 | Weekly summary email. **DEFERRED — 3 design decisions needed first.** | Post-sprint |
| G-10 | NOVA reviews Kisi API docs, confirms schema assumptions | Adapter build start |
| RI-01 | **PARSE research: Wix plan modification behavior.** Does Wix change `plan_id` on rename/reprice? Does archiving fire `plan.cancelled`? Load-bearing assumption — must verify before HOG launch. | HOG correctness |
| DEF-01 | Role-based Admin Hub access. **Deferred — trigger: second client onboard.** | Multi-client scale |

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
- **Vault-First Question Rule (ALL agents — mandatory):** Before asking Daxx any question, search the vault for the answer. If the vault has a clear answer, use it. If it has a partial answer, state what was found and what specifically remains unresolved. Only ask Daxx what the vault genuinely cannot answer.
- **Agent idle exit rule:** Any automated/headless agent must exit after 3 consecutive idle polling cycles with no new tasks. Never loop indefinitely. Log a final status summary before exiting.

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
**Standards register:** `AccessSync/STANDARDS.md` — living log of proven patterns (AI, logging, UX, auth, best practices)
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
| v4.3 | 2026-04-10 | Pre-HOG code complete. WIRE-G-01 closed (retryPendingHardwareMembers scoped to plan mapping PATCH). U-09 closed (all platform-specific copy removed from operator UI + onboarding + sync-status). Humanizer pass complete — all 6 operator pages + onboarding portal. Graphify rebuilt (262 nodes, 370 edges). HANDOFF_BRIEF + APP_CONTEXT updated to reflect closed gaps. |
| v4.4 | 2026-04-14 | operator.js code quality cleanup: structured logger migration (~75 console.* → log.*), error response hardening (19 err.message leaks sealed), OB-46 stale catch removed, 6 inline requires hoisted, N+1 INSERT loops batched, front matter added per protocol. 32/32 tests DEPLOY SAFE. |
| v4.5 | 2026-04-20 | Added SAGE Approval Rule — all non-trivial changes require SAGE review before implementation. SAGE pulls in supporting agents as needed; UX/UI changes automatically include FORGE, LENS, PIXEL, REAM. |

*Archive of prior versions: `01_Project_Foundation/Claude_Versions/`*