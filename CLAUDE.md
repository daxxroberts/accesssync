# CLAUDE.md — AccessSync (repo)
**Version:** 5.7 (parity with vault) | **Updated:** 2026-05-21 | **Author:** Daxx Roberts / KEEPER

> **Synced with vault CLAUDE.md 2026-05-21.** This file lives in the repo (`accesssync/CLAUDE.md`) and is the build-time context Claude Code loads on every repo session. Mirror of vault `CLAUDE.md` Repository State + Schema + Locked Decisions + Env Vars sections. Full vault CLAUDE.md (with Phase 1/2 sequence banners, session protocols, BOT team) is the source of truth — read that file when in doubt. Never edit this repo file in isolation; KEEPER syncs both at session close.

> **Read this file before writing a single line of code. Then read `AccessSync/open_items.md`. Then read the spec for what you're building.**

---

## What This Is

AccessSync is a SaaS product that automates physical space access control for fitness operators and SMBs. When a member purchases a pricing plan through a connected membership or booking platform, AccessSync automatically provisions their access credentials in the hardware access control system. No manual operator action required.

**AccessSync is platform-agnostic at its core.** The architecture supports any membership/booking platform (currently: Wix) and any hardware access control platform (currently: Kisi; Seam stubbed for post-V1). Strip the Wix layers and everything underneath runs identically with a different platform connector.

**First client:** House of Gains (Chad) — Kisi Pro tier, $199/mo/location.

---

## Deployment Environment

**Compute on Railway. Database on Supabase as of 2026-05-20 cutover (DR-047 / OB-180).** All app services and crons run on Railway; the live Postgres is now Supabase. Never:
- Start a local dev server
- Create a `.env` file for local use
- Suggest `localhost` testing
- Run Railway CLI commands to proxy local connections

**Hardcoded URLs — use these directly. Never run `railway variables` to look them up:**

| Service | Public URL |
|---|---|
| Core Engine | `https://accesssync-production.up.railway.app` |
| Admin Hub | `https://accesssync-admin.up.railway.app` |
| Postgres (LIVE — Supabase) | `postgresql://postgres.gklgwyrnkedebyulrclv:<password>@aws-1-us-west-1.pooler.supabase.com:5432/postgres` (session-mode pooler — port 5432, NOT 6543) |
| Postgres (DEPRECATED — Railway, paused-but-alive through Phase 7) | `postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway` |

**Live DB project (Supabase):** `gklgwyrnkedebyulrclv` (us-west-1 California, Free tier). RLS disabled per OB-181 (gated on client #2). For ad-hoc SQL, **prefer Supabase MCP tools** (`mcp__claude_ai_Supabase__execute_sql`, `apply_migration`, `list_tables`) — no password handling. For Node-side queries:
```js
const { Client } = require('pg');
const PASSWORD = process.env.SUPABASE_DB_PASSWORD;
const client = new Client({
  connectionString: `postgresql://postgres.gklgwyrnkedebyulrclv:${encodeURIComponent(PASSWORD)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`,
  ssl: { rejectUnauthorized: false }
});
```

**Rollback target:** Railway Postgres remains paused-but-alive until Phase 7 decommission (1+ month signal-based, post 2026-06-20 earliest). Rollback procedure: `~/.claude/projects/.../memory/reference_supabase_rollback.md`.

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

**Phase 1 COMPLETE 2026-05-20.** S-11 schema migration BUILT and shipped (commits `88df167` / `cea397f` / `93d1909`, 2026-05-15); OB-185 reconcile two-pass SHIPPED (commits `6693870` / `9156ddb`, 2026-05-17); OB-187 Pass 1 billing backfill SHIPPED (commits `16e856d` / `47c5dc6`, 2026-05-18); OB-179 Members React per-person plan iteration SHIPPED (commit `7ac64a0`, 2026-05-18); DR-047 Supabase migration EXECUTED (commit `1e5f407`, 2026-05-20). 441/441 tests DEPLOY SAFE.

**Live state highlights:**
- 23 tables on Supabase (post-S-11). DR-046 5-table member model in production.
- Per-person `member_access` cardinality live: UNIQUE `(member_master_id, client_id)`, status enum `active`/`inactive`/`in_flight`/`pending_identity`.
- A9/A10/A11 multi-tenancy hardening live: `member_access_sources.client_id NOT NULL` FK CASCADE; `member_billing` UNIQUE includes client_id; P3 regression test guards INSERTs.
- Reconcile observe-and-log behavior: Kisi assignments outside DB source rows are preserved, not revoked. Operator-side manual grants safe indefinitely.
- DR-045 three-layer Kisi delete guard live (Layer A DB source_tag + Layer B Kisi notes marker + Layer C Kisi elevated-role check).
- DR-044 sub-member soft-delete with PII purge live (verified end-to-end on Drew Roberts revoke 2026-04-30).
- Members React page (React 18 + Babel-standalone island) live with per-person plan iteration and compact expanded-plans table.

**Phase 2 sequence (next):** OB-184 cleanup ledger triage → operator UI walkthrough (LENS+FORGE+Daxx) → OB-176 logger EVENT_REGISTRY allowlist → RULE-16/17/18 SAGE-lock → other open work.

**Pending HOG-blocking:** OB-63 (set `clients.site_id` for HOG), OB-64 (install Wix Dashboard Page Extension), OB-93 (HOG events.js reinstall — operational), business gates G-01/02/05/06.

**Key files (post-S-11):**
- `db.js` — pg pool, query helper, getClient(), healthCheck(). Single DATABASE_URL entry point.
- `server.js` — Core Engine entry. BullMQ worker boot, SIGTERM shutdown.
- `adapters/wix/wix-connector.js` — Layer 1. HTTP handler, HMAC verification (req.rawBody), X-AccessSync-Client-Id header → tenantResolver.registerSiteId().
- `adapters/wix/wix-adapter.js` — Layer 2. parseEvent() → standard event object. Zero deps. Multi-path memberId/planId resolution. `_normalizeEventType` covers `orderAutoRenewCanceled`, `orderEnded`, `orderPurchased`, `orderStarted`, `orderExpired`, `orderPaused`, `orderResumed`.
- `adapters/wix/wix-members-api.js` — Wix Members API client. RS256 verification, `@users.wix.com` rejection. Rate-limited via core/rate-limiter.js (10 req/sec).
- `adapters/wix/wix-plans-api.js` — Wix Pricing Plans + Bookings REST client. `GET /pricing-plans/v2/orders` (list variant — queryOrders endpoint removed by Wix, OB-85 fix). `POST /_api/bookings-reader/v2/extended-bookings/query` (OB-86 fix). Fail-closed on HTTP errors (OB-87).
- `adapters/standard-adapter.js` — Layer 3. Owns `member_master` UPSERT, `member_access` per-(person × client) UPSERT, `member_access_sources` writes (per-mapping in 'pending_hardware' / 'pending_start' / 'active' / 'cancelled' via parkPendingHardware/parkPendingStart/completeGrant/completeRevoke), in_flight lock. resolveAndLock(), resolveIdentity() (Wix Members API resolve ladder per OB-89), releaseLock() (translates legacy 'failed'/'pending_hardware' → 'inactive'). Writes client_activity_summary (DR-024). `_maybeFireFirstGrantEmail()` atomic first-grant welcome email.
- `adapters/hardware-adapter.js` — Layer 5. Hardware platform router. Delegates kisi/seam by hardwarePlatform string. `assignRole(options.validUntil)`. INVALID_HARDWARE_REQUEST validator gate.
- `adapters/kisi/kisi-adapter.js` — Layer 6. Kisi business methods. `getGroups`, `assignRole(validUntil)`, `getLocks` returns normalized `{id, name, locked}`. **DR-045 three-layer delete guard:** Layer B marker stamping on POST/PATCH `notes`, Layer C elevated-role refusal in `deleteUser`. `findElevatedAssignments` + `getRoleAssignmentsForUser` helpers.
- `adapters/kisi/kisi-connector.js` — Layer 7. Kisi HTTP client, rate-limited via core/rate-limiter.js (5 req/sec per DR-008).
- `adapters/seam/*` — Stubs. Post-V1.
- `core/queue-worker.js` — Layer coordinator. resolveAndLock → resolveIdentity → grantRevokeLogic → completeGrant/Revoke. Concurrency 20. payment.recovered early-exit (enableAccess only). UnrecoverableError for 4xx. Lifecycle breadcrumbs via lastStep.
- `core/webhook-processor.js` — BullMQ Queue, real DB dedup, tenant resolution. `eventQueue` exported.
- `core/grant-revoke.js` — Pure grant/revoke logic. `processGrant` loops mappings[] (pre-grant source check OB-47). `processRevoke` source-row delete first → remaining-count check → hardware removeRole only if 0 (DR-034 OB-48). DR-045 Layer A `source_tag` guard on `deleteUser`. `newHardwareCallMade` flag gates `member_access_log` INSERT.
- `core/reconciliation.js` — Two-pass post-OB-185 (commit `6693870`). **Pass 1:** for each Wix-active member, promote source rows `cancelled→active` + INSERT-missing-source per (member × plan × hardware_group) via `plan_mappings` + `plan_mapping_groups` (commit `ffc0f84`). Backfills `member_billing` from Wix order state (commit `16e856d` / `47c5dc6`). **Pass 2:** observe-and-log orphan Kisi assignments (no synthetic-revoke); A12 universe pre-filter to AccessSync-managed groups only. `reconcileMember(memberId, clientId)` for operator-triggered repair. Synthetic events route through L3 (DR-023 boundary preserved). Fail-closed on Wix API errors (OB-87).
- `core/plan-mapping-resolver.js` — Returns Array of all active mappings (DR-026). Filters `status='active'`. Resolves per-mapping `hardware_api_key` (DR-028/DR-035) and `subscription_status='active'` filter (DR-027).
- `core/billing-snapshot.js` — Pure extractor. Wix order pricing → JSONB snapshot. Keyed off `entity._id` for webhook payloads (use `id` for REST list per OB-187 fix).
- `core/trace-context.js` — `setTraceContext(traceId, opts)` UPDATE-with-COALESCE. `getTraceId()`/`getActor()`/`runWith` ALS primitives.
- `core/hmac-monitor.js` — Redis sliding window. 3 failures in 5 min → Resend alert. 10-min cooldown.
- `core/hardware-health-check.js` — 6-hourly Railway Cron. Tests each client's hardware_api_key via `getLocks()`. Per-error diagnosis email.
- `core/tenant-resolver.js` — site_id → client_id with 5-min cache. `registerSiteId(clientId, siteId)` idempotent UPDATE.
- `core/crypto-utils.js` — AES-256-GCM encrypt/decrypt for hardware_api_key + wix_api_key (DR-028). `API_KEY_ENCRYPTION_KEY` env var.
- `core/retry-engine.js` — Exponential backoff. `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/member-sync-api.js` — RS256 JWT verification. Returns enriched access array.
- `core/location-lapse.js` — `suspendLocationMembers()`. Admin routes POST .../suspend + /activate.
- `core/wix-plans-api.js` — (operator-side queries — see `adapters/wix/wix-plans-api.js` for reconcile-side).
- `core/EVENT_REGISTRY.md` — Full event vocabulary (~50 events, 11 domains). DR-038 governed.
- `core/redaction-allowlist.json` — `always_safe` / `never_log` / `redact_if_pattern_matches`. DR-039 governed.
- `core/rate-limiter.js` — Shared sliding-window helper. Wired into Wix API + Kisi connector.
- `admin/server.js` — Express. EJS view engine. 5 operator routes use `requireAuthPageOrOperator`. `/admin-panel` uses `requireAuthPage` (owner only). `/onboard` no auth gate. `allowWixFrame` middleware. Mounts `portalRoutes` at `/operator-portal`.
- `admin/middleware/auth.js` — JWT httpOnly cookie. `signToken` (admin 24h). `signOperatorToken` (operator 8h scoped to clientId). `requireAuth`, `requireAuthPage`, `requireAuthPageOrOperator`.
- `admin/middleware/wix-instance.js` — Verifies Wix signed instance token (HMAC-SHA256 with WIX_APP_SECRET). Rejects anonymous (aid). Confirms site owner. Sets `req.wixOperator`. No-client → `/onboard?siteId=<instanceId>`.
- `admin/middleware/activity.js` — `recordActivity(req, event, ctx)`. Fire-and-forget INSERT to `activity_event`. setImmediate, never blocks. DR-037.
- `admin/middleware/trace-context.js` — `traceContextMiddleware` + `resolveActor`. ALS context on every Express request. DR-037.
- `admin/routes/portal.js` — GET `/operator-portal` (requireWixInstance). GET `/operator-portal/setup` (requireAuthPageOrOperator).
- `admin/routes/operator.js` — Full operator API. Paginated members (post-S-11: nested sources, JOIN `member_billing` via `mas.billing_id` for A1 rate fix). Per-member sync endpoint `POST /:clientId/members/:memberId/sync`.
- `admin/routes/multi-member.js` — Member Hub sub-member flow. Post-S-11: drafts write source rows in 'draft' status. Slot counts JOIN `member_access_sources` for per-mapping scoping. DR-044 soft-delete state machine.
- `admin/routes/clients.js` — Clients panel. Test stored key via Kisi GET /groups?limit=1.
- `admin/routes/auth.js`, `errors.js`, `members.js` (Debug Center), `webhooks.js`, `queue.js` — see vault CLAUDE.md.
- `admin/public/members-bridge.js` — API → React data adapter. Post-S-11 + OB-179: iterates `plan_names[]` per person, derives planSet from each person's plans, computes uniqueBillingCount, fires `membersLoaded` event.
- `admin/public/members-app.jsx` + `members-data.jsx` + `members-parts.jsx` + `members-icons.jsx` + `tweaks-panel.jsx` — React 18 + Babel-standalone island. Members Page v2 + post-S-11 plan iteration. Dropped "Relationship" column 2026-05-18. Compact expanded-plans-table styling.
- `admin/views/pages/members.ejs` — Thin EJS shell mounting React island. Server-injects `window.__CLIENT_ID`.
- `admin/views/pages/dashboard.ejs`, `plan-mapping.ejs`, `access.ejs`, `locations.ejs`, `admin-panel.ejs`, `sync-status.ejs`, `onboard.ejs`, `portal-setup.ejs`, `multi-member.ejs` — see vault CLAUDE.md.
- `migrations/s11.sql` — DR-046 + A9/A10/A11. Applied to Railway 2026-05-15 pre-merge; carried into Supabase via bootstrap.sql 2026-05-20.
- `migrations/supabase-bootstrap.sql` — Full 23-table schema snapshot. 34 KB.
- `migrations/supabase-data.sql` — 1.8 MB data dump (3,778 rows; 48h log-table filter applied).
- `migrations/dr-040.sql`, `dr-041.sql`, `dr-042.sql`, `dr-044.sql`, etc. — pre-S-11 migrations. Now historical.
- `scripts/supabase-1-dump-schema.js`, `supabase-2-dump-data.js`, `supabase-3-apply-data.js`, `supabase-4-backfill-missing.js` — Path B migration artifacts (DR-047 execution).
- `scripts/trace.js` — Updated 2026-05-20 to compose Supabase URL from `SUPABASE_DB_PASSWORD`.

---

## Architecture — 7-Layer Model (DR-022)

```
Layer 1: Wix Connector            adapters/wix/wix-connector.js
  HTTP handler, HMAC-SHA256 verification only. Calls Layer 2.

Layer 2: Wix Adapter Layer        adapters/wix/wix-adapter.js
  Wix payload parsing. parseEvent() → standard event object. Zero dependencies.

Layer 3: Standard Adapter Layer   adapters/standard-adapter.js
  Owns member_master, member_access, member_access_sources, in_flight lock.
  resolveAndLock(), resolveIdentity() (Wix Members API ladder), parkPendingHardware(),
  parkPendingStart(), completeGrant(), completeRevoke() (source-aware), releaseLock().
  Daily client_activity_summary UPSERT. First grant email.

Layer 4: Core Engine              core/
  webhook-processor.js     Deduplication, BullMQ enqueue
  queue-worker.js          Layer coordinator — orchestrates L3+L4+L5
  grant-revoke.js          Pure grant/revoke + DR-045 Layer A delete guard
  plan-mapping-resolver.js source_plan_id → hardware group lookup
  retry-engine.js          Exponential backoff, dead-letter to error_queue
  reconciliation.js        Two-pass: Wix-active promote + INSERT-missing,
                           orphan observe-and-log (no auto-revoke)
  billing-snapshot.js      Wix order pricing → JSONB snapshot
  trace-context.js         ALS + setTraceContext(UPDATE-with-COALESCE)

Layer 5: Hardware Standard Adapter  adapters/hardware-adapter.js
  Platform router. Delegates to Layer 6 by hardwarePlatform string.
  INVALID_HARDWARE_REQUEST validator gate.
  Interface: findUserByEmail, createUser, assignRole(validUntil),
             removeRole, suspendAccess, enableAccess, deleteUser, getLocks

Layer 6: Kisi Adapter Layer       adapters/kisi/kisi-adapter.js
  Kisi business methods. DR-045 three-layer delete guard:
    Layer B (notes marker stamp/parse), Layer C (elevated-role refusal).
  createUser hard-requires options.clientId. suspendAccess/enableAccess re-stamp marker.

Layer 7: Kisi Connector           adapters/kisi/kisi-connector.js
  Kisi HTTP client, rate limiting (5 req/sec via core/rate-limiter.js), auth headers.
```

**Backward-compat shims (DR-022):** `adapters/wix-adapter.js` → L1. `adapters/kisi-adapter.js` → L6. `adapters/seam-adapter.js` → L6 stub.

**Queue layer:** BullMQ + Railway Redis. `webhook-processor.js` enqueues `'grant'`/`'revoke'` jobs. `queue-worker.js` coordinates. Dead-letter via `worker.on('failed')` → `retry-engine`.

**Platform adapter contract (DR-021):** All adapters set `platformMemberId` + `sourcePlatform` in the normalized event object. Core Engine never references platform-specific IDs.

**Hosting:** Railway compute, Supabase DB. Entry: `server.js`. Crons: `node core/reconciliation.js` (nightly), `node core/hardware-health-check.js` (every 6 hours). Health: `GET /health`.

---

## Schema — 23 Tables (post-S-11, live on Supabase)

**23 tables live on Supabase project `gklgwyrnkedebyulrclv` as of 2026-05-20 cutover.** Retired in S-10 (2026-05-12): `member_identity`, `member_access_state`, `member_role_assignments`. Schema source-of-truth is the live DB — query via Supabase MCP `list_tables` / `execute_sql`. Historical schema files (`schema.sql`, `docs/data-model.html`, `04_Data/Data_Model.md`) deleted 2026-05-13 (commit `fb79ea6`) because they contradicted production state.

### Member-side tables (DR-046)

| Table | Purpose |
|---|---|
| `member_master` | One row per human per client. UNIQUE `(client_id, source_platform, platform_member_id)`. Email + name + `source_tag` for Layer A delete guard (DR-045). |
| `member_billing` | One row per (client_id, wix_order_id, cycle_index) — A10 strengthened UNIQUE. `billing_snapshot` jsonb captures Wix order pricing at grant time (DR-042). |
| `member_access` | **One row per person per client (DR-046).** UNIQUE `(member_master_id, client_id)`. Status enum: `active` / `inactive` / `in_flight` / `pending_identity`. `active` if ≥1 source active. |
| `member_access_sources` | One row per Kisi role assignment + reason. UNIQUE `(client_id, access_id, source_type, source_plan_id, hardware_group_id)` — A9. `client_id NOT NULL` FK CASCADE. Status enum: `draft` / `active` / `pending_hardware` / `pending_start` / `failed` / `cancelled` / `revoked`. |
| `member_access_log` | Lifecycle audit log. Trace-enriched (DR-037). |

### Operator config tables

| Table | Purpose |
|---|---|
| `clients` | One row per operator account. `hardware_api_key` (encrypted, DR-028), `notification_email`, `first_grant_sent`, `last_webhook_at`, `wix_api_key` (encrypted), `source_site_name`, `kisi_user_pattern` ('invited' default, DR-043). |
| `locations` | One row per physical location. `hardware_api_key` (per-location override, encrypted), `hardware_key_last_verified`, `hardware_key_last_error`. |
| `plan_mappings` | Maps `source_plan_id` to location. `access_type`, `plan_name`, `door_name`, `status`. Multi-group via `plan_mapping_groups` junction. |
| `plan_mapping_groups` | Junction table for multi-door plan mappings — one row per (mapping_id, hardware_group_id). |

### Subscription tables (DR-036)

| Table | Purpose |
|---|---|
| `connector_subscriptions` | Per-(client + hardware platform). `hardware_platform` string + `hardware_api_key` (encrypted). Canonical post-cutover; supersedes `clients.hardware_platform`. |
| `billing_subscriptions` | Per-(client + subscription_source + subscription_id). Wires AccessSync tier to Wix App Market / direct billing source. |
| `as_subscription_terms` | Valid tier definitions (Base / Pro / Connect) with rate-limit + feature flags. |
| `as_client_subscriptions` | Per-client AccessSync subscription record. |

### Observability + queue tables

| Table | Purpose |
|---|---|
| `webhook_log` | Raw inbound webhook record. Trace-enriched. |
| `error_queue` | Dead-letter + operator-visible errors. Trace + actor context. |
| `diagnostic_log` | Structured warn/error events. Trace + actor context. |
| `activity_event` | Operator activity feed (DR-037). |
| `config_alert_log` | Configuration issue alerts. |
| `adapter_admin_log` | Operator configuration issues. `configured_by`, `configured_at` (DR-019). |
| `trace_context` | Per-trace-id lookup table (DR-041). LEFT JOINed into `v_trace_timeline`. |
| `client_activity_summary` | Daily UPSERT per client — events_received, grants_completed, revokes_completed, errors_count (DR-024). |
| `processed_event_ids` | Idempotency table (DR-010). |

### Views

| View | Purpose |
|---|---|
| `v_trace_timeline` | UNION-ALL across 7 log tables, LEFT JOINed to `trace_context` for human-readable display fields. |

---

## Locked Decisions — Do Not Revisit Without SAGE

| DR | Decision |
|---|---|
| DR-001 | No PII storage — re-pull email from platform at reconciliation. (DR-001-A amendment pending — email caching gated on OB-95/96/97.) |
| DR-003 | `source_tag = 'accesssync'` on all managed users — distinguishes from manual. Layer A of DR-045 delete guard. |
| DR-005 | Hardware lockdown override — actions skip, not fail. |
| ~~DR-007~~ | ~~Managed users — provisioned with `send_emails: false`.~~ **SUPERSEDED 2026-04-30 by DR-043** (`kisi_user_pattern='invited'` is platform default). |
| DR-008 | Pricing — $30/$60/$150 (Base/Pro/Connect). Rate limit: 5 req/sec (Kisi). |
| DR-009 | HMAC-SHA256 signature verification on all inbound webhooks. |
| DR-010 | Idempotency via `processed_event_ids` table. |
| DR-011 | Kisi routes direct API, not through Seam. |
| DR-012 | BullMQ on Railway Redis for job queue. |
| DR-013 | `member_identity` A/B schema concept — column names superseded by DR-021. (Table itself dropped in S-10 cutover 2026-05-12.) |
| DR-014 | Color system — Indigo `#4F6EF7` (`--brand`) / Sage `#4ADE80` (`--sage`). Non-interchangeable. (OB-116 amendment for 7-source palette pending.) |
| DR-015 | Mobile-first UI — 320px baseline. FORGE + LENS enforce. |
| DR-016 | HOG Phase 1: Velo direct install, not App Market packaging. |
| DR-017 | HOG Phase 1: Regular users, Terminal Pro pattern. (Superseded by DR-043 platform default.) |
| DR-018 | `last_sync_at` as column on `clients` table. |
| DR-019 | `adapter_admin_log` — `configured_by` + `configured_at` nullable columns. |
| DR-020 | Operator email via Resend SDK. `clients.notification_email` per-client; `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` env var fallback. |
| DR-021 | `platform_member_id` + `source_platform` — platform-agnostic member identity. |
| DR-022 | 7-layer architecture — canonical layer model, file paths, shim pattern. |
| DR-023 | Standard Adapter Layer (L3) exclusively owns `member_master` UPSERT, `member_access` writes, in_flight lock. Core Engine never writes these tables directly. |
| DR-024 | `client_activity_summary` — Standard Adapter Layer, daily UPSERT. Fault-tolerant. |
| DR-025 | `locations` table. `clients`: +site_url, +last_webhook_at. `plan_mappings`: +location_id, +plan_name, +door_name, +status. |
| DR-026 | Multi-door provisioning. (`member_role_assignments` table dropped in S-10; multi-door now via `member_access_sources` per DR-046.) |
| DR-027 | Per-location subscription model. `plan-mapping-resolver.js` filters `subscription_status = 'active'` locations. |
| DR-028 | Hardware API key storage — `clients.hardware_api_key` (org default, encrypted) + `locations.hardware_api_key` (nullable override). AES-256-GCM via `core/crypto-utils.js`. |
| DR-029 | Sub-member ID format — `{wix_uuid}###as{6-char-random}` (amended 2026-04-30 — was `{NNN}` counter). Random suffix eliminates reuse-after-revoke collisions. |
| DR-030 | `plan_holder_id` on member-side tables. NULL for single/booking members. |
| DR-031 | Upstream explosion pattern — family events exploded in Layer 2. |
| DR-032 | Family plan draft→submit workflow. |
| DR-033 | Unified member access widget — 3 modes via `planType`. |
| DR-034 | `member_access_sources` — multi-source grant/revoke. Pre-grant source check (OB-47). Revoke fires hardware DELETE only when all sources gone (OB-48). Augmented by DR-046. |
| DR-035 | Platform-agnostic column renames: `kisi_api_key → hardware_api_key`, `wix_plan_id → source_plan_id`. |
| DR-036 | `connector_subscriptions` + `billing_subscriptions` + `as_subscription_terms` + `as_client_subscriptions` (4-table model — supersedes original `client_subscriptions` single-table design). Subscription_source + subscription_id pattern mirrors DR-021. |
| DR-037 | Observability architecture — ALS trace context, EVENT_REGISTRY (DR-038), redaction allowlist (DR-039). Forward-compatible with OTel. |
| DR-038 | Event registry standard — two-canon model. `core/EVENT_REGISTRY.md` (repo, code-loaded) + `07_Logging_Observability/Event_Registry.md` (vault mirror). |
| DR-039 | Redaction allowlist — schema-driven + runtime regex backstop. `core/redaction-allowlist.json`. |
| DR-040 | Per-plan sub-member assignment. `member_master.plan_mapping_id UUID REFERENCES plan_mappings(id) ON DELETE SET NULL`. NULL for primary members. |
| DR-041 | `trace_context` lookup table — one row per trace_id. `v_trace_timeline` LEFT JOIN enrichment. |
| DR-042 | `billing_snapshot` jsonb. Now lives on `member_billing` (was `member_role_assignments` pre-S-11). Extracted by `core/billing-snapshot.js`. |
| DR-043 | Per-tenant Kisi user pattern (`clients.kisi_user_pattern VARCHAR(20) DEFAULT 'invited'`). Supersedes DR-017. |
| DR-044 | Sub-member soft-delete with PII purge — terminal `sub_member_status='deleted'` after successful revoke. Lineage preserved. State machine: draft → hard-delete; submitted/active → removing → deleted. |
| DR-045 | **Three-layer Kisi delete guard.** Layer A (DB `source_tag`) + Layer B (Kisi `notes` marker `[AS\|managed\|<clientId>\|<createdAt-ISO>] <reason>`) + Layer C (refuse delete of users with elevated roles). `createUser` hard-requires `options.clientId`. Verified end-to-end on HOG 2026-05-13. |
| DR-046 | **Per-person `member_access` cardinality — LOCKED + BUILT 2026-05-15.** UNIQUE `(member_master_id, client_id)`. Status binary (active if ≥1 active source, else inactive). Per-plan state on `member_access_sources`. 5-table model live in production. Spec: `04_Data/SCHEMA_S11_SPEC.md`. Commits `88df167` + `cea397f` + `93d1909`. |
| DR-047 | **Migrate Postgres from Railway to Supabase — EXECUTED 2026-05-20.** Live DB is Supabase `gklgwyrnkedebyulrclv`. Path B (Node `pg` + Supabase MCP) used after libpq vs Railway proxy TLS handshake blocked canonical `pg_dump`/`psql`. Railway Postgres paused-but-alive through Phase 7. Commit `1e5f407`. |

Full decision records: `AccessSync/13_Decision_Records/`. Vault DECISION_LOG: `AccessSync/13_Decision_Records/DECISION_LOG.md`.

---

## Open Build Items — Read Before Any Build Session

See vault `AccessSync/open_items.md` for the full ledger. Headline items:

| ID | Item | Blocks |
|---|---|---|
| OB-184 | **Post-S-11 cleanup ledger** — running list at `10_Specifications/OB-184_Cleanup_Ledger.md`. 12+ entries (CL-01 through CL-12). Phase 2 step 1. | Cleanup sprint |
| OB-176 | **Logger persistence via EVENT_REGISTRY allowlist** — replace level-based gate with event-name allowlist. | Phase 2 logging |
| OB-181 | **RLS sprint** — gated on client #2 in pipeline. ~4-6h focused work. Reuses A9/A10/A11. | Multi-client security |
| OB-186 | **Kisi tab + Unmatched Door Access dashboard** — operator-facing surface for OB-185 Pass 2 orphan observations. | Operator console post-OB-185 |
| OB-19 | **Railway deployment** — env vars, HOG real Kisi API key. | HOG go-live |
| OB-63 | **Set `clients.site_id` for HOG via Supabase**. | HOG portal flow |
| OB-64 | **Wix Dashboard Page Extension for HOG**. | HOG portal flow |
| OB-93 | **HOG events.js reinstall** — operational. | HOG real-time provisioning |
| OB-189 | **Supabase Free→Pro tier upgrade triggers**. | Multi-client scale |
| OB-190 | **`COMMENT ON TABLE/COLUMN` business-documentation pass** against Supabase. | Schema discoverability |

---

## Hard Gates — Nothing Ships Without These Closed

| Gate | Status |
|---|---|
| G-01 | Chad signed agreement | Open |
| G-02 | LLC formation | Open |
| G-03 | Kisi reseller agreement | **CLOSED 2026-04-10** |
| G-04 | Wix developer account | **CLOSED 2026-04-02** |
| G-05 | Business technology insurance | Open |
| G-06 | Failure runbook complete | Open |
| G-07 | Michael partnership decision | **CLOSED 2026-03-24 (no partnership)** |
| G-08 | Kisi API access from Joe | **CLOSED 2026-04-10** |
| G-09 | Chad confirmed on Kisi Pro tier | **CLOSED 2026-04-10** |
| G-10 | NOVA reviews Kisi API docs | Open |

---

## Environment Variables Required

```
# Core Engine (Railway app service — node server.js)
DATABASE_URL                          Supabase session-mode pooler URL (live as of 2026-05-20)
SUPABASE_DB_PASSWORD                  Supabase DB password (alternative to DATABASE_URL for scripts)
REDIS_URL                             Railway Redis connection string
WIX_WEBHOOK_SECRET                    HMAC secret from Wix developer dashboard
PORT                                  Set by Railway automatically
NODE_ENV                              development | production
RESEND_API_KEY                        Resend API key
RESEND_FROM_EMAIL                     Sender address — DR-020
ACCESSSYNC_OWNER_NOTIFICATION_EMAIL   Platform owner email (Daxx)
API_KEY_ENCRYPTION_KEY                64-char hex string — AES-256-GCM for hardware + Wix API keys
DEFAULT_TENANT_ID                     Temporary placeholder

# Admin Hub service (Railway — node admin/server.js)
ADMIN_JWT_SECRET                      Random 64-char string — JWT signing secret
GOOGLE_CLIENT_ID                      OAuth 2.0 Client ID
ADMIN_ALLOWED_EMAIL                   daxxroberts@gmail.com
OWNER_PIN                             Owner PIN to bypass hardware key validation during onboarding
OPERATOR_INVITE_TOKEN                 Gate on operator signup endpoints
CORE_ENGINE_URL                       Core Engine base URL — populates webhook URL in onboard Step 5
WIX_APP_ID                            Wix App ID
WIX_APP_SECRET                        Wix App Secret Key — verifies signed instance HMAC
```

---

## Family Plan — Hard Stop

**⚠️ DO NOT begin any family/multi-member plan build work before HOG go-live.**

DR-029 through DR-033 are locked and ready. The `member_access_widget.html` is a Velo iframe design reference only. This block will not lift until Chad confirms HOG sells family memberships.

(Note: DR-040 + DR-044 added sub-member draft-submit and soft-delete behavior post-DR-033, both live and verified — but full family plan UI activation still gated on Chad confirmation.)

---

## Pre-Commit / Pre-Push Gate

**Before any `git commit` or `git push`, run the test suite:**

```bash
npm run test:deploy
```

This runs the business-risk-aware test framework (P1/P2/P3 tiers). The output is either `DEPLOY SAFE` or `DO NOT DEPLOY`.

- **DEPLOY SAFE** — all P1/P2/P3 tests pass. Commit or push may proceed.
- **DO NOT DEPLOY** — fix failing tests first, re-run before proceeding.

**Never skip this gate.** P1 tests cover the core grant/revoke/suspend paths.

Current count: 441 tests across 40 suites (as of 2026-05-18).

---

## Team Protocol

This project is managed by the Business Operating Team (BOT). The vault is the single source of truth.

**Full team definition + governance rules + session protocols:** `AccessSync/CLAUDE.md` (vault — v5.8 as of 2026-05-21) and `C:\Users\daxxr\.claude\skills\business-operating-team\SKILL.md`.

**Quick reference:**
- No architectural decisions without SAGE sign-off.
- No vault changes without KEEPER proposal → SAGE review → Daxx approval.
- NOVA never designs against memory — always reads repo and vault first.
- Vault-First Rule: before asking Daxx anything, search the vault first.
- Deferred-UI Rule: every skip button/placeholder CTA has a matching OB in `open_items.md`.

---

## CLAUDE.md Version History

| Version | Date | Summary |
|---|---|---|
| v1.0–v3.9 | 2026-03-07 to 2026-04-01 | Initial setup through Phase 2+3 + Sprint 5 complete. |
| v4.0–v4.6 | 2026-04-02 to 2026-04-10 | AI-forward KB, DR-035, OB-46/47/48 cycle, Operator Portal, all migrations applied. |
| v4.7–v4.10 | 2026-04-13 to 2026-04-26 | DR-036 client_subscriptions, OB-78 close, OB-85/86/87 Wix endpoint fixes, OB-88/89 PR shipping, Per-member reconcile (OB-49 partial). |
| v4.11–v4.13 | 2026-04-27 | Member Hub redesign, Members Page v2 React island, DR-040 renumber, OB-47 close, EVENT_REGISTRY + redaction-allowlist + activity_event live. |
| v4.14–v4.15 | 2026-04-28 | Sprint 6 (Trace Timeline UI) scoped. Phase 1 trace plumbing fix shipped — 14 INSERTs across 8 files threaded trace_id; new P3 regression test. OB-117 closed. |
| v4.16 | 2026-04-29 | OB-48 closed (audit). OB-125 logged. DR-042 billing_snapshot on MRA. DR-043 kisi_user_pattern. |
| v4.17 | 2026-04-30 | DR-029 amended (random suffix), DR-044 LOCKED (sub-member soft-delete). Product Tracks (7-track portfolio + Finance/Infrastructure tracks added). |
| v4.18 | 2026-04-30 | Product Tracks introduced — 7-track portfolio hierarchy. Finance + Infrastructure tracks added. 17 new OBs (OB-128–144). |
| v4.19 | 2026-04-30 | DR-044 LOCKED — sub-member soft-delete with PII purge. Verified end-to-end on Drew Roberts revoke. |
| v5.0 | 2026-05-12 | **Schema migration complete (S-1 through S-10).** Old tables dropped (`member_identity` / `member_access_state` / `member_role_assignments`). New tables live: `member_master`, `member_billing`, `connector_subscriptions`, `billing_subscriptions`, `as_subscription_terms`, `as_client_subscriptions`. |
| v5.1 | 2026-05-13 | DR-045 LOCKED — Kisi notes-field ownership marker. Two-layer delete guard. 339 test users deleted. |
| v5.2 | 2026-05-13 | DR-045 Layer C amendment same-day — elevated-role check. 3 of 6 HOG users hold elevated roles. Verified live. |
| v5.3 | 2026-05-13 | STALE-DOC SWEEP — pre-S-10 schema docs deleted (commit `fb79ea6`). |
| v5.4 | 2026-05-13 | **DR-046 LOCKED (DESIGN)** — per-person `member_access` cardinality. 5-table model. Build = S-11 sprint. |
| v5.5 | 2026-05-13 | Phase 1 canonical next-session sequence locked: S-11 → OB-176 logging → reconcile-3-HOG → validate Daxx → validate test users → UI walkthrough → other work. |
| v5.6 | 2026-05-15 | **DR-047 LOCKED PLAN** — Supabase migration after S-11. 6 amendments + 3 strengthenings. RULE-15 (design-rationale capture) locked. |
| v5.7 | 2026-05-20 | **DR-047 EXECUTED** — AccessSync LIVE on Supabase. Path B used after libpq blocked canonical path. OB-180 closed. RULE-16 + RULE-17 proposed. |
| **v5.7-parity (repo)** | **2026-05-21** | **Repo CLAUDE.md (this file) synced to v5.7 vault parity.** Was v4.17 (5 versions behind). Replaced 14-table schema with 23-table, added DR-043 through DR-047, added Supabase deployment, full file list rewrite. Vault file simultaneously bumped to v5.8 with Phase 1 marked COMPLETE + Phase 2 sequence + RULE-18 proposal. |

*Full vault version history: `AccessSync/CLAUDE.md` and `01_Project_Foundation/Claude_Versions/`*

---

## Knowledge Base

**Vault location:** `C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync`

**Start here:** `AccessSync/CLAUDE.md` (v5.8 — source of truth)
**Open items:** `AccessSync/open_items.md`
**Decisions:** `AccessSync/13_Decision_Records/DECISION_LOG.md`
**Tracks view:** `AccessSync/tracks.md`
**Spec source-of-truth (S-11):** `AccessSync/04_Data/SCHEMA_S11_SPEC.md`
**Cleanup ledger:** `AccessSync/10_Specifications/OB-184_Cleanup_Ledger.md`
**Supabase migration plan:** `AccessSync/04_Data/SUPABASE_MIGRATION_PLAN.md`
