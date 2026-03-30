# CLAUDE.md — AccessSync Core Engine
**Version:** 3.3 | **Updated:** 2026-03-29 | **Author:** KEEPER (Business Operating Team)

---

## What This Is

AccessSync is a Wix App Market SaaS product that automates physical space access control for gym and fitness operators. When a member purchases a Wix pricing plan, AccessSync automatically provisions their access credentials in the hardware system (Kisi or Seam). No manual operator action required.

**First client:** House of Gains (Chad) — Kisi Pro tier, $199/mo/location.

---

## Repository State

**V1 code-complete. Admin Hub V1 deployed and live. 7-layer architecture complete (DR-022/023/024/025/026/027/028). OB-08 closed — Wix JWT live. OB-20 closed — location lapse flow built. Onboarding wizard + Member Sync panel added. Pending: OB-13 (email search — now unblocked).**

**Current status as of 2026-03-29:**
- `schema.sql` — DR-018 through DR-026 applied. 13 tables total. Added: `member_role_assignments` (DR-026), `access_type` column on `plan_mappings` (DR-026). ✅ OB-18 closed — both Railway migrations applied.
- `db.js` — ✅ Built. pg pool, query helper, `getClient()`, `healthCheck()`, `pool` exported.
- `adapters/wix/wix-connector.js` — ✅ Layer 1. HTTP handler, HMAC verification only. Calls wix-adapter.parseEvent().
- `adapters/wix/wix-adapter.js` — ✅ Layer 2. Wix payload parsing only. parseEvent() → standard event object. Zero dependencies.
- `adapters/standard-adapter.js` — ✅ Layer 3. Owns member_identity, member_access_state, in_flight lock (DR-023). resolveAndLock(), resolveIdentity(), completeGrant(), completeRevoke(), releaseLock(). Writes client_activity_summary (DR-024).
- `adapters/hardware-adapter.js` — ✅ Layer 5. Hardware platform router. Delegates to kisi/seam by hardwarePlatform string (DR-022).
- `adapters/kisi/kisi-adapter.js` — ✅ Layer 6. Kisi business methods. Calls kisi-connector.
- `adapters/kisi/kisi-connector.js` — ✅ Layer 7. Kisi HTTP client, rate limiting, auth headers.
- `adapters/seam/seam-adapter.js` — Stub. Layer 6 equivalent. Post-V1.
- `adapters/seam/seam-connector.js` — Stub. Layer 7 equivalent. Post-V1.
- `adapters/wix-adapter.js` — Shim → `./wix/wix-connector` (DR-022 backward compat).
- `adapters/kisi-adapter.js` — Shim → `./kisi/kisi-adapter` (DR-022 backward compat).
- `adapters/seam-adapter.js` — Shim → `./seam/seam-adapter` (DR-022 backward compat).
- `server.js` — ✅ Fully implemented. Imports `adapters/wix/wix-connector` (DR-022). DB health check, BullMQ worker boot, SIGTERM graceful shutdown.
- `core/queue-worker.js` — ✅ Built. Layer coordinator. Calls standardAdapter (resolve/lock/complete) around grantRevokeLogic. `payment.recovered` early-exit path (enableAccess only). `UnrecoverableError` for 4xx errors (DR-026).
- `core/tenant-resolver.js` — ✅ Built. `site_id` → `client_id` with 5-min cache.
- `core/webhook-processor.js` — ✅ Built. BullMQ Queue, real DB dedup, tenant resolution, `eventQueue` exported.
- `core/plan-mapping-resolver.js` — ✅ Built. Returns Array of all active mappings (DR-026). `status='active'` filter. Includes `mappingId` + `accessType`.
- `core/grant-revoke.js` — ✅ Built. `processGrant` loops all mappings[], returns `assignments[]`. `processRevoke` loops all `roleAssignmentIds[]`. Identity/lock/state owned by Standard Adapter (DR-023).
- `core/retry-engine.js` — ✅ Built. `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/reconciliation.js` — ✅ Built. Calls hardwareAdapter.getLocks() (DR-022). Stale lock cleanup, failed job re-queue, operator digest.
- `core/member-sync-api.js` — ✅ Built. RS256 JWT verification live (OB-08 closed). Raw DB access state for Velo frontend.
- `core/location-lapse.js` — ✅ Built. OB-20. suspendLocationMembers() — suspends all active members at a location when subscription lapses. DR-027 billing integrity.
- `admin/server.js` — ✅ Built. Separate Express app. Crash-isolated from Core Engine.
- `admin/middleware/auth.js` — ✅ Built. JWT httpOnly cookie.
- `admin/routes/auth.js` — ✅ Built. Google OAuth. Auth-001 closed.
- `admin/routes/errors.js` — ✅ Built. Full Error Queue CRUD + BullMQ retry.
- `admin/routes/members.js` — ✅ Built. Debug Center — search, timeline, retry.
- `admin/routes/webhooks.js` — ✅ Built. Webhook Inspector — recent + detail.
- `admin/routes/queue.js` — ✅ Built. Queue Monitor — counts + jobs by state.
- `admin/routes/clients.js` — ✅ Built. Clients panel — GET / (with member counts), PATCH /:id.
- `admin/public/index.html` — ✅ Built. Dashboard shell — 5 panels, login screen, drawer, modal.
- `admin/public/app.js` — ✅ Built. Full frontend logic — auth, panels, polling, interactions.
- `admin/public/styles.css` — ✅ Built. Full CSS v2.0 — brand, layout, components, responsive.
- `admin/public/dashboard.html` — ✅ Built. Operator dashboard. Edit button navigates to /mapping.html.
- `admin/public/onboard.html` — ✅ Built. Operator-facing multi-step onboarding wizard (Wix Site → Your Plan → Location → Connect Doors → All Set). No admin auth gate. Calls `/operator/*` endpoints. Pro tier = high-traffic door. Step 5 amber reminder if API key skipped. Back to Dashboard links to `/dashboard.html?clientId=...`.
- `admin/public/mapping.html` — ✅ Built. Plan mapping matrix screen. Wired to live data via /operator/:clientId/locations/:locationId/mappings.
- `admin/routes/operator.js` — ✅ Built. Operator API. Public signup endpoints: POST /operator/clients, POST /operator/clients/:id/locations, POST /operator/clients/:id/api-key (no admin JWT — OB-24 tracks pre-launch auth). Operator data endpoints: GET /operator/:clientId/members, /alerts, /errors, /locations/:locationId/mappings + PATCH /operator/:clientId/plan-mappings/:id.

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

**Hosting:** Railway. Entry: `server.js`. Cron: `node core/reconciliation.js`. Health: `GET /health`.

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
| DR-020 | Operator email via Resend SDK from Core Engine. `clients.notification_email` per-client; `OPERATOR_NOTIFICATION_EMAIL` env var is HOG Phase 1 fallback (until OB-09 setup wizard). |
| DR-021 | `member_identity.platform_member_id` (was `wix_member_id`) + `source_platform` column. All adapters set `platformMemberId` + `sourcePlatform`. UNIQUE: `(client_id, source_platform, platform_member_id)`. |
| DR-022 | 7-layer architecture — canonical layer model, file paths, shim pattern for backward compat. |
| DR-023 | Standard Adapter Layer (Layer 3) exclusively owns `member_identity` UPSERT, `member_access_state` writes, and in_flight lock acquire/release. Core Engine never writes these tables directly. |
| DR-024 | `client_activity_summary` table — Standard Adapter Layer, daily UPSERT per client. events_received, grants_completed, revokes_completed, errors_count. Fault-tolerant (log but don't throw). |
| DR-025 | `locations` table (id, client_id, name, city, state). `clients`: +site_url, +last_wix_webhook_at. `plan_mappings`: +location_id, +plan_name, +door_name, +status. `error_queue`: +location_id, +plan_name, +door_name. `kisi_org_id` excluded (G-10 open). `error_reason` maps to `plain_message` in API layer — no rename. |
| DR-026 | Multi-door provisioning — `member_role_assignments` table (one row per member per mapping, UNIQUE constraint, idempotent). `plan_mappings.access_type DEFAULT 'group'` for future Seam routing. Resolver returns Array. `payment.recovered` = enableAccess only. `UnrecoverableError` for 4xx hardware errors. Legacy fallback: `member_access_state.role_assignment_id` if `member_role_assignments` empty. Railway migration required (OB-18). |
| DR-027 | Per-location subscription model — one AccessSync subscription per physical location (AccessSync pricing decision, not a Kisi constraint). `locations` gets: `subscription_status` (default `'inactive'`), `tier`, `subscribed_at`, `subscription_id`. `plan-mapping-resolver.js` filters to `subscription_status = 'active'` locations only. Location lapse flow required (OB-20). OB-22: confirm HOG Wix pattern with Chad. |
| DR-028 | Kisi API key storage — `clients.kisi_api_key` (org-level default) + `locations.kisi_api_key` (nullable override for multi-org operators). Lookup: `location.kisi_api_key \|\| client.kisi_api_key`. AES-256-GCM encryption via `core/crypto-utils.js` + `KISI_ENCRYPTION_KEY` env var. `KISI_API_KEY_MOCK` deprecated after OB-23. |

Full decision records are in the vault: `AccessSync/13_Decision_Records/`

---

## Open Build Items — Next Layer

| ID | Item | Blocks |
|---|---|---|
| ~~OB-12~~ | ~~Deploy Admin Hub V1 to Railway~~ — ~~CLOSED 2026-03-27. Live at https://accesssync-admin.up.railway.app~~ | ~~Admin Hub live~~ |
| ~~OB-14~~ | ~~Run 6 pending Railway schema migrations on live Postgres~~ — ~~CLOSED 2026-03-28. All migrations applied.~~ | ~~Admin Hub panels functional~~ |
| ~~OB-18~~ | ~~Railway DB migration — DR-026: `access_type` column + `member_role_assignments` table~~ — ~~CLOSED 2026-03-28. Both migrations applied to live Railway Postgres.~~ | ~~Multi-door grant/revoke in production~~ |
| OB-13 | Debug Center email search — GET /members/search?email= calls Wix API to resolve email → platformMemberId. OB-08 now closed — **UNBLOCKED**. Build next session. | Debug Center full search |
| ~~OB-03-A~~ | ~~CLOSED 2026-03-29 — `wix-connector.js` corrected. Reads `req.body?.instanceId`. PARSE VERIFIED: no `x-wix-site-id` header.~~ | ~~Multi-tenant correctness~~ |
| OB-19 | Railway migration — 6 ALTER statements (DR-027 + DR-028 bundled). `locations`: `subscription_status`, `tier`, `subscribed_at`, `subscription_id`. `clients`: `kisi_api_key VARCHAR(500)`. `locations`: `kisi_api_key VARCHAR(500)`. Add `KISI_ENCRYPTION_KEY` env var first. | Per-location billing + API key DB storage |
| OB-23 | Build `core/crypto-utils.js` (AES-256-GCM). Update `kisi-connector.js` to read API key from DB. Add key input to Admin Hub Clients panel (write-only). Remove `KISI_API_KEY_MOCK` after wired. | Multi-client onboarding |
| ~~OB-20~~ | ~~CLOSED 2026-03-29 — `core/location-lapse.js`. suspendLocationMembers() suspends active members at a location. Admin routes: POST .../suspend + .../activate.~~ | ~~Billing integrity~~ |
| OB-21 | `plan-mapping-resolver.js` — add `JOIN locations` + `subscription_status = 'active'` filter (DR-027). | Provisioning gate for unsubscribed locations |
| OB-22 | Confirm HOG Wix pattern with Chad — one site for all locations or separate sites? | HOG Phase 1 correctness |
| ~~OB-05~~ | ~~CLOSED 2026-03-29 — Operator API endpoints added to `admin/routes/operator.js`: GET /:clientId/members, /alerts, /errors. OB-06 Wix widget unblocked.~~ | ~~OB-06, operator visibility~~ |
| OB-06 | PIXEL — Wix Account screen widget reading from OB-05 | Operator dashboard |
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
KISI_API_KEY_MOCK             DEPRECATED — Phase 1 placeholder. Replaced by DB lookup (clients.kisi_api_key / locations.kisi_api_key) after OB-23 is closed.
KISI_ENCRYPTION_KEY           32-byte hex string for AES-256-GCM API key encryption (DR-028). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PORT                          Set by Railway automatically
NODE_ENV                      development | production
DEFAULT_TENANT_ID             Temporary placeholder — remove when multi-tenant routing is built
RESEND_API_KEY                Resend API key (from resend.com dashboard) — DR-020
RESEND_FROM_EMAIL             Sender address (e.g. alerts@accesssync.io) — DR-020
OPERATOR_NOTIFICATION_EMAIL   Phase 1 HOG fallback — until setup wizard OB-09 is built — DR-020

# Admin Hub service (separate Railway service — node admin/server.js)
ADMIN_JWT_SECRET              Random 64-char string — JWT signing secret for admin sessions
GOOGLE_CLIENT_ID              OAuth 2.0 Client ID from Google Cloud Console (public — safe to expose)
ADMIN_ALLOWED_EMAIL           daxxroberts@gmail.com — only this Google account can log in
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
