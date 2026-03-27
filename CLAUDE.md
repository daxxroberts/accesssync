# CLAUDE.md — AccessSync Core Engine
**Version:** 1.9 | **Updated:** 2026-03-26 | **Author:** KEEPER (Business Operating Team)

---

## What This Is

AccessSync is a Wix App Market SaaS product that automates physical space access control for gym and fitness operators. When a member purchases a Wix pricing plan, AccessSync automatically provisions their access credentials in the hardware system (Kisi or Seam). No manual operator action required.

**First client:** House of Gains (Chad) — Kisi Pro tier, $199/mo/location.

---

## Repository State

**V1 code-complete as of 2026-03-26. Phase 2+3 done. Pending OB-05 (operator API) and OB-09 (setup wizard).**

**Current status as of 2026-03-26:**
- `schema.sql` — Final. DR-018 through DR-021 applied. Migration comments added.
- `db.js` — ✅ Built. pg pool, query helper, `getClient()`, `healthCheck()`, `pool` exported.
- `adapters/kisi-adapter.js` — ✅ Fully implemented. Rate limiting, 429 backoff, all methods, `getLocks()` added.
- `adapters/wix-adapter.js` — ✅ Fully implemented. HMAC verification, `platformMemberId` + `sourcePlatform: 'wix'` in normalized event (DR-021). OB-03-A TODO present.
- `server.js` — ✅ Fully implemented. DB health check, BullMQ worker boot, SIGTERM graceful shutdown (OI-09).
- `core/queue-worker.js` — ✅ Built. BullMQ Worker. Dead-letter via `worker.on('failed')` → retryEngine.
- `core/tenant-resolver.js` — ✅ Built. `wix_site_id` → `client_id` with 5-min cache.
- `core/webhook-processor.js` — ✅ Built. BullMQ Queue, real DB dedup, tenant resolution, `eventQueue` exported.
- `core/plan-mapping-resolver.js` — ✅ Built. Real DB read from `plan_mappings`.
- `core/grant-revoke.js` — ✅ Built. Atomic in_flight lock, identity resolution, all paths write to DB. Catch blocks `throw error` (BUG-01 fixed). DR-021 SQL updated.
- `core/retry-engine.js` — ✅ Built. DB import, `standardEvent` extraction from `job.data`, `_moveToDeadLetter` (error_queue), `_notifyOperator` (Resend SDK, DR-020).
- `core/reconciliation.js` — ✅ Built. All stubs wired: stale lock cleanup, `_fetchActionableRecords`, `_processRecordTargeted` (BullMQ re-queue), `_syncDoorLockdownStates`, `_generateAndSendDigest` (Resend).
- `core/member-sync-api.js` — ✅ Built. Raw DB read only. No UI state mapping (Velo owns — OB-07). JWT stubbed (OB-08).
- `seam-adapter.js` — Stub only. Seam is post-V1.

---

## Architecture — Three-Layer Model

```
Layer 2: Platform Adapters
  wix-adapter.js          Receives Wix webhooks, verifies HMAC, normalizes event

Layer 4: Core Engine
  webhook-processor.js    Deduplication, routing to grant/revoke
  grant-revoke.js         Identity resolution, provision/revoke flows
  plan-mapping-resolver.js  Wix Plan ID → hardware group lookup
  retry-engine.js         Exponential backoff, dead-letter to error_queue
  reconciliation.js       Nightly sweep: failed/skipped jobs, operator digest

Layer 5: Hardware Adapters
  kisi-adapter.js         Direct Kisi REST API — fully implemented
  seam-adapter.js         Seam stub — post-V1
```

**Queue layer:** BullMQ + Railway Redis. `webhook-processor.js` routes to BullMQ queue. `queue-worker.js` consumes and routes to grant/revoke. Dead-letter on max retries via `worker.on('failed')` → `retry-engine`.

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

Full decision records are in the vault: `AccessSync/13_Decision_Records/`

---

## Open Build Items — Next Layer

| ID | Item | Blocks |
|---|---|---|
| OB-03-A | Verify Wix site ID header field name (`x-wix-site-id`) via PARSE/Wix docs | Multi-tenant correctness |
| OB-05 | `core/operator-api.js` — operator-facing API: GET /operator/members, /alerts, /errors | Operator account visibility |
| OB-06 | PIXEL — Wix Account screen widget reading from OB-05 | Operator dashboard |
| OB-07 | Confirm Velo owns UI state display logic for `member-sync-api.js` output | Sync screen Velo build |
| OB-08 | Implement real Wix JWT verification in `_verifyWixJWT()` — OB-08 | Phase 5 launch (security gate) |
| OB-09 | FORGE — setup wizard email input → `clients.notification_email` | DR-020 operator notifications |
| G-10 | NOVA reviews Kisi API docs, confirms schema assumptions | Adapter build start |

Full open items list: `AccessSync/open_items.md`

---

## Environment Variables Required

```
DATABASE_URL                  PostgreSQL connection string (Railway)
WIX_WEBHOOK_SECRET            HMAC secret from Wix developer dashboard
KISI_API_KEY_MOCK             Replace with per-client key lookup from DB
PORT                          Set by Railway automatically
NODE_ENV                      development | production
DEFAULT_TENANT_ID             Temporary placeholder — remove when multi-tenant routing is built
RESEND_API_KEY                Resend API key (from resend.com dashboard) — DR-020
RESEND_FROM_EMAIL             Sender address (e.g. alerts@accesssync.io) — DR-020
OPERATOR_NOTIFICATION_EMAIL   Phase 1 HOG fallback — until setup wizard OB-09 is built — DR-020
```

---

## Knowledge Base

**Vault location:**
`C:\Users\daxxr\OneDrive\Documents - Personal OneDrive\Projects\WORK\Business Files\AccessSync\AccessSync`

**Vault version:** 1.7.0
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

---

## KEEPER Protocol — Session Close (MANDATORY)

**KEEPER must run this checklist before any session ends where code, schema, decisions, or vault files changed. No exceptions.**

### Files KEEPER must always check and update:

| File | Action |
|---|---|
| `changelog.md` | Append new session entry — what changed, what was decided, what was built |
| `00_Vault_Control/KB_FILE_REGISTRY.md` | Add any new files created this session; update status of changed files |
| `00_Vault_Control/VAULT_SUBSTANCE_MAP.md` | Add one-line summary for every new file |
| `00_Vault_Control/VAULT_INDEX.md` | Update only if folder structure changed |
| `open_items.md` | Capture any new open items, blockers, or decisions surfaced this session |
| `CLAUDE.md` | Bump version + update Repository State if build progress was made |

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
