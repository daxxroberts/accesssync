---
type: vault_control
domain: ai_bundle
status: active
owner: keeper
related_systems: [bundle_assembly, decision_log]
last_updated: 2026-04-29
mirrors: 13_Decision_Records/DECISION_LOG.md
---

# Condensed Decision Ledger

> **Two-sentence summary of every locked Decision Record. Used by the bundle assembler at button-click time so AI summaries can reason about why the system behaves the way it does. KEEPER maintains this file alongside `DECISION_LOG.md` — both files move together; sessions never close with one updated and the other stale.**

> **Format per entry:**
> Sentence 1 — what the decision is.
> Sentence 2 — what it implies operationally (why it matters when reading a trace).
>
> **If the AI flags a DR as "unclear" in a Bundle gap, KEEPER expands that specific entry to a third sentence. Targeted clarification only.**

---

## Active Decisions

### DR-001 — No PII storage; re-pull email from Wix at reconciliation
AccessSync does not persist member emails or names long-term — the source platform (Wix) is the authoritative store, and we fetch on-demand for reconciliation. **Operationally:** if a trace shows `member_name = null` or an email recovery firing, that's the privacy design at work, not missing data.

### DR-002 — Access Adapter Layer is the bidirectional identity bridge
The Standard Adapter Layer (Layer 3) translates between the source platform's member identity and the hardware platform's user identity. **Operationally:** identity drift between the two sides flows through Layer 3 — bugs that show wrong member↔hardware mappings localize there.

### DR-003 — `source_tag = 'accesssync'` on every managed user
Every Kisi user AccessSync provisions is tagged so reconciliation can distinguish managed users from manually-created staff/contractor users. **Operationally:** reconcile only acts on rows where `source_tag = 'accesssync'`; bugs that touch a manually-managed Kisi user are out of scope.

### DR-004 — `member_access_log` is a lifecycle table, not operational noise
Each row represents a meaningful transition (provisioned, revoked, disabled, deleted) — not every retry, not every webhook fire. **Operationally:** if a trace has zero `member_access_log` rows, no actual access change happened — only attempts.

### DR-005 — Hardware lockdown override: actions skip, not fail
When Kisi is in lockdown mode, AccessSync's grant/revoke calls silently skip rather than error. **Operationally:** if a trace shows `lockdown_detected` and grant didn't happen, that's expected behavior — not a bug, retry won't help until lockdown clears.

### DR-006 — Member sync screen is a one-time post-purchase UI
The sync-status screen the member sees after checkout polls until access is provisioned, then exits — it's not a persistent dashboard. **Operationally:** sync-screen-related events (`/sync-status`, `/member/access-status`) only appear in traces during the few minutes after a purchase.

### DR-007 — Kisi user type: managed users (white-label, `send_emails: false`)
For all clients except HOG, AccessSync provisions Kisi users with `send_emails: false` so the operator's brand isn't broken by Kisi's onboarding emails. **Operationally:** if a member never gets a welcome email, that's the white-label default — except for HOG (DR-017).

### DR-008 — Pricing: $30 / $60 / $150 flat tiers; Kisi rate limit 5 req/sec
Three tiers (Base/Pro/Connect) at fixed monthly per-location pricing; Kisi's API rate limit is 5 requests/second per platform. **Operationally:** rate-limit errors during a burst of grant calls are expected to back-pressure naturally.

### DR-009 — Kisi legal: API connector model (attorney-flagged)
AccessSync operates as a Kisi API connector under their reseller agreement, not as a managed-services provider. **Operationally:** legal posture; doesn't affect runtime traces but affects what we can store and how reconciliation runs.

### DR-010 — `config_alert_log` is a dedicated operator-issue table
Configuration problems (missing plan mapping, missing API key, missing hardware group) fire to `config_alert_log` — separate from `error_queue`, which is for transient failures. **Operationally:** alerts in `config_alert_log` need operator action; entries in `error_queue` are usually retryable.

### DR-011 — Kisi routes direct API, not through Seam
We call Kisi's API directly for Kisi clients rather than routing through Seam. **Operationally:** Seam adapter files are stubs; any Kisi-related issue localizes to `adapters/kisi/`, not Seam.

### DR-012 — Core Engine infrastructure: BullMQ + Railway cron + configurable email
Async work runs through BullMQ on Railway Redis; periodic work runs through Railway cron; operator notifications go through Resend. **Operationally:** if a trace has `queue.job.start` and never `queue.job.complete`, BullMQ has the job and it's still working.

### DR-013 — `member_identity` A/B schema concept (column names superseded by DR-021)
Originally specified two member-ID slots to support cross-platform member identity. **Operationally:** the *concept* (one source identity, one hardware identity) holds; column names changed in DR-021 to `source_platform`/`platform_member_id`/`hardware_platform`/`hardware_user_id`.

### DR-014 — Color system: Indigo brand, Sage status, non-interchangeable
`#4F6EF7` (Indigo, `--brand`) is the brand color; `#4ADE80` (Sage, `--sage`) is the success/status color — they are never swapped. **Operationally:** UI bugs that show brand-colored success states or sage-colored CTAs are DR-014 violations.

### DR-015 — Mobile-first build standard, 320px baseline
Every operator-facing screen must work down to 320px viewport width. **Operationally:** UI rendering bugs that only surface above 768px are still bugs and need fixing.

### DR-016 — Velo direct install for HOG Phase 1 (not App Market packaging)
HOG installs AccessSync via direct Velo backend code, not through the Wix App Market. **Operationally:** webhooks arrive via Velo's `events.js` rather than through Wix's App Market signed-instance HMAC path; only HOG follows this path.

### DR-017 — HOG Phase 1: regular users (not managed)
For HOG specifically, Kisi users are provisioned as regular users with `send_emails: true` (Terminal Pro install pattern), overriding DR-007. **Operationally:** HOG members get Kisi welcome emails on first provision; other clients do not.

### DR-018 — `last_sync_at` as a column on `clients` (not a separate table)
Single timestamp per client, stored on the client row, rather than a separate sync history table. **Operationally:** there's no historical sync log — only "when did the last sync run for this client."

### DR-019 — `adapter_admin_log.configured_by` / `configured_at` (nullable)
Audit columns added to track who/when changed configuration; nullable to preserve pre-existing rows. **Operationally:** older rows lack these fields; don't treat NULL as suspicious.

### DR-020 — Operator email notifications via Resend SDK from Core Engine
Email goes through Resend, with `clients.notification_email` as the per-client destination and `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` as the platform fallback. **Operationally:** missing emails after a failure usually mean Resend is unconfigured or the env var is missing — not a code bug.

### DR-021 — `member_identity` source-platform-agnostic refactor
Renamed `wix_member_id → platform_member_id` and added `source_platform`; UNIQUE constraint is `(client_id, source_platform, platform_member_id)`. **Operationally:** the same person on two source platforms gets two `member_identity` rows; duplicate rows for the same person on the same platform with different `platform_member_id`s are bugs (see Drew's case 2026-04-29).

### DR-022 — 7-layer architecture (canonical layer model)
Layer 1 Wix Connector → L2 Wix Adapter → L3 Standard Adapter → L4 Core Engine → L5 Hardware Standard Adapter → L6 Kisi Adapter → L7 Kisi Connector. **Operationally:** when localizing a bug, the namespace prefix on an event (`adapter.*`, `grant.*`, `kisi.*`) usually maps directly to the layer it originated from.

### DR-023 — Layer 3 exclusively owns identity + state writes
Only the Standard Adapter writes `member_identity`, `member_access_state`, and the in-flight lock — Layer 4 never touches these tables. **Operationally:** if a trace shows L4 errors with "DB write failed for member_identity," that's a DR-023 violation; bug is at the call site that bypassed L3.

### DR-024 — `client_activity_summary` daily UPSERT (fault-tolerant)
Layer 3 increments daily counters (`events_received`, `grants_completed`, etc.); writes are best-effort and never block the grant/revoke path. **Operationally:** missing or undercounting summary rows are warnings, not errors — the underlying trace data is authoritative.

### DR-025 — `locations` table; `clients` and `plan_mappings` extended
Each client has multiple locations; plan_mappings reference both client and location, with name/door labels for human readability. **Operationally:** plan mappings without a location_id are legacy and apply at the client level.

### DR-026 — Multi-door provisioning: `member_role_assignments`
One row per member per mapping (UNIQUE constraint), enabling a member to be on multiple doors via multiple Kisi role assignments. **Operationally:** the count of `member_role_assignments` rows for a member should equal the number of doors they have access to; mismatch indicates incomplete grants.

### DR-027 — Per-location subscription model
Each location has its own AccessSync subscription (`subscription_status`, `tier`); the plan-mapping resolver only returns mappings for locations whose subscription is `active`. **Operationally:** if a member's plan exists but no grant fires, check the location's subscription status — lapsed subscriptions silently skip.

### DR-028 — Hardware API key storage: encrypted with location override
`clients.hardware_api_key` is the org-level default (AES-256-GCM encrypted); `locations.hardware_api_key` is a per-location override; lookup is `location.key || client.key`. **Operationally:** a missing/invalid key at one location can fail grants for that location while others succeed — alerts will fire to `config_alert_log`.

### DR-029 — Sub-member ID format `{wix_uuid}###as{NNN}` (DEFERRED post-HOG)
Sub-members get a deterministic synthetic platform_member_id derived from the plan holder's Wix UUID. **Operationally:** family-plan code is dormant pre-HOG; sub-member rows in production are operator test data only.

### DR-030 — `plan_holder_id` column on member tables (DEFERRED post-HOG)
Sub-members link to their plan holder via `plan_holder_id`; NULL for single-plan and event-booking members. **Operationally:** rows with `plan_holder_id IS NOT NULL` are sub-members; family-plan logic is post-HOG.

### DR-031 — Upstream explosion pattern for family events (DEFERRED)
Layer 2 explodes a single `plan_members` event into per-member synthetic events before Layer 4 sees them; Core Engine treats them as singletons. **Operationally:** family-plan code is dormant pre-HOG.

### DR-032 — Family plan draft→submit workflow (DEFERRED)
Operator builds a sub-member list in draft state, then submits the batch atomically — no provisioning happens until submit. **Operationally:** dormant pre-HOG.

### DR-033 — Unified member access widget, three modes via `planType` (DEFERRED)
Single HTML widget renders single/event/family modes via a `planType` variable. **Operationally:** dormant pre-HOG.

### DR-034 — `member_access_sources` (multi-source grant/revoke)
Tracks why a member is in a Kisi group (plan, booking, or family_plan); revoke only fires the Kisi DELETE when all sources are gone. **Operationally:** if a member is on two plans and one cancels, their hardware access stays — that's the source-count check working, not a stale revoke.

### DR-035 — Platform-agnostic column renames (kisi_api_key → hardware_api_key, etc.)
Renamed `kisi_api_key → hardware_api_key` and `wix_plan_id → source_plan_id` to support multiple hardware/source platforms. **Operationally:** older code or vault docs referencing the old names are stale; the live schema uses the new names exclusively.

### DR-036 — `client_subscriptions` table (platform-agnostic billing)
New table holding billing records per client subscription (source/id pair); supersedes `locations.tier`/`subscription_status` and `plan_mappings.tier_name`. **Operationally:** mid-migration; older code still reads the legacy columns via dual-read until OB-71 closes.

### DR-037 — Observability architecture: ALS context + unified timeline + registries
Universal `trace_id` + actor context via Node `AsyncLocalStorage`; unified timeline via `v_trace_timeline` UNION-ALL view across 7 log tables; event registry + redaction allowlist govern what gets logged. **Operationally:** every event in production carries a trace_id linking it to its full chain — when a trace_id is missing, that's a plumbing bug, not a real failure.

### DR-038 — Event registry standard (two-canon model, naming convention)
`core/EVENT_REGISTRY.md` is the canonical source of every event AccessSync emits; format is `<domain>.<subject>.<verb_past_tense>`, lowercase, dot-separated. **Operationally:** an event in a trace not present in EVENT_REGISTRY is either undocumented (registry is stale) or invalid (code is firing an unregistered event).

### DR-039 — Redaction allowlist (two-layer enforcement)
Schema-driven allowlist of sensitive field names + runtime regex backstop for token/JWT/Bearer-shape patterns; AXIOM gates every event-adding PR. **Operationally:** PII or secrets that appear in a trace's payload bypass redaction — flag immediately.

### DR-040 — Per-plan sub-member assignment (`plan_mapping_id` on member_identity)
Sub-member quota is enforced per plan rather than pooled across the holder's plans (renumbered from DR-037 to resolve collision). **Operationally:** a holder with two multi-member plans gets independent sub-member pools per plan.

---

## Open / Pending Decisions (not yet locked, included for AI context)

- `credential_value` storage — `member_access_log` vs live fetch from Seam. (Pre-Seam build.)
- `06_AI_Systems` scope — V1, post-MVP, or removed. (Pre-AI feature build.)
- Static vs AI-generated sync screen error messages. (Pre-sync screen build.)
- Kisi MSA termination/suspension terms — business continuity risk. (Pre-Connect tier launch.)
- Regular vs managed users per-client config flag. (Post-MVP, Terminal Pro pattern.)

---

## Change history

| Version | Date | Change |
|---|---|---|
| v0.1.0 | 2026-04-29 | Initial draft. 40 active DRs condensed to 2-sentence summaries; deferred family-plan DRs flagged; superseded DRs noted. |
