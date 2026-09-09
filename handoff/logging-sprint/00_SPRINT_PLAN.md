# Logging Foundation Sprint — Master Plan

**Status:** APPROVED — pending three Daxx confirmations (see § Pre-Conditions)
**Authority:** SAGE (ship/no-ship) · NOVA (engineering lead) · REX (coordination)
**Estimated effort:** 2–3 focused build days
**Module:** 2 (BOT Team / Build phase)
**Phase:** Pre-HOG infrastructure
**Created:** 2026-04-27 by REX
**Source session:** SAGE-led architecture review with NOVA · ATLAS · ORION · AXIOM · FAULT · CIRCUIT · KEEPER

---

## Why this sprint exists

AccessSync has the building blocks of trace logging — schema columns, helper APIs, a structured emitter, an audit middleware — but propagation is wired through only one path (Wix → queue → provisioning). Operator UI clicks, member API calls, owner actions, and crons are all traceless. Six log tables exist with no shared trace ID discipline; there is no JOIN that gives you "everything that happened in one user action."

The bug Daxx debugged on 2026-04-27 (disappearing badge + traceless disconnect) cost ~30 minutes of manual cross-table queries to reconstruct. With proper trace logging, that investigation would have been a 5-second SELECT. Every future incident response carries this same multiplier.

This sprint installs the propagation discipline. Three primitives. One ship.

---

## What gets built

### Primitive 1 — Universal context (AsyncLocalStorage)
Every entry point mints a trace ID and binds an actor. The context propagates automatically through every async call. No call-site changes; every existing `log.*()` call automatically gains `trace_id`, `actor_type`, `actor_id` fields.

**Entry points:**
- Express middleware (admin + operator routes)
- BullMQ job handler (worker boots context from job payload)
- Cron starters (reconciliation, hardware-health-check)
- Internal API callers (admin → core proxy)
- Webhook entry (already exists — refactored to use ALS)

### Primitive 2 — Unified timeline
- Add three columns to all six existing log tables: `trace_id VARCHAR(36)`, `actor_type VARCHAR(20)`, `actor_id VARCHAR(64)`. NULL-defaulted, additive, non-breaking.
- New table `activity_event` — captures user actions that don't fit existing tables (operator UI clicks, member portal actions, owner admin edits, system-generated events).
- New view `v_trace_timeline` — UNION ALL across all log tables ordered by timestamp, queryable by `trace_id`.

### Primitive 3 — Event vocabulary + redaction
- `core/EVENT_REGISTRY.md` — the canonical event taxonomy. Every event documented: name, meaning, context fields, KEDB code if applicable. AXIOM-gated PRs to add events.
- Schema-driven redaction allowlist: known secret/PII fields are replaced with `[REDACTED]` before any log write.
- Runtime regex backstop in the logger: catches missed secrets (Resend `re_*`, Stripe-style `sk_*`, JWT shape, Kisi keys) even if the developer forgot.

---

## What is explicitly NOT being built (non-goals — AXIOM-stamped)

| Non-goal | Why deferred | Trigger to revisit |
|---|---|---|
| OpenTelemetry compatibility | Custom is right for AI-readability requirement | Enterprise customer demands SOC 2 audit feed |
| Span hierarchy (parent/child spans) | Flat trace is sufficient at current scale | One trace covers >20 events on average |
| Migrating existing log table content | Forward-only is safer + simpler | Never — historical data stays NULL |
| UI for log viewing (this sprint) | Built next, in OB-LOG-02 | This sprint ships |
| Auto-instrumenting third-party libraries | Only AccessSync code paths | Performance regression in a library |

---

## Pre-Conditions (REQUIRED before sprint starts)

REX does not begin coordination until all three are confirmed by Daxx in writing (chat acknowledgment counts).

| # | Confirmation | Rationale | Status |
|---|---|---|---|
| PC-1 | No hard external HOG deadline that would be threatened by 2–3 days of pre-sprint work | M1 mitigation from STEEL pressure test | ⚪ Pending |
| PC-2 | Approve three sealed mitigations: (a) AXIOM redaction gate + runtime regex backstop, (b) Day-1 checkpoint with scope-trim path, (c) PC-1 deadline check | E3, C3, M1 mitigations | ⚪ Pending |
| PC-3 | Greenlight KEEPER to file DR-036, DR-037, DR-038 + OB-LOG-01, OB-LOG-02 in open_items.md + vault updates **before any code is written** | KEEPER protocol — no code on draft specs | ⚪ Pending |

When all three are ⚪ → 🟢, REX moves to Phase 0.

---

## Phase 0 — Vault hygiene + documentation

Phase 0 was expanded after Daxx caught that the BOT team had not read the existing `07_Logging_Observability/` files before drafting the sprint plan. Vault hygiene is now the first work — must complete before any code is written.

### Phase 0a — Vault hygiene (KEEPER + QUILL · ~2 hours)

Six files in `07_Logging_Observability/` plus related: audit, rule, file. SAGE-approved 2026-04-27.

| Step | File | Action | Owner |
|---|---|---|---|
| 0a.1 | `07_Logging_Observability/Logging_Strategy.md` | **Update in place** — rewrite app-layer paragraph + field-name section against `core/logger.js` reality. Bump to v2.1.0. | QUILL |
| 0a.2 | `07_Logging_Observability/Event_Types.md` | **Supersede + archive** — replace with new canonical `Event_Registry.md` mirroring repo `core/EVENT_REGISTRY.md` | KEEPER + QUILL |
| 0a.3 | `07_Logging_Observability/Error_Codes.md` | **Supersede + archive** — replace with KEDB-aligned doc mirroring `core/logger.js` KEDB constant | KEEPER + QUILL |
| 0a.4 | `07_Logging_Observability/Incident_Signals.md` | **Update in place** — rewrite signal sources against actual events/tables; preserve P1/P2/P3/P4 framing | QUILL |
| 0a.5 | `07_Logging_Observability/Monitoring_Rules.md` | **Mark as deferred** — system not built; status `deferred` with note pointing to OB-LOG-01 | KEEPER |
| 0a.6 | `07_Logging_Observability/UX_Session_Log_2026-04-09.md` | **Move to archive folder** — `99_Archive/session-logs/` | KEEPER |
| 0a.7 | `STANDARDS.md` Logging section | **Audit existing 3 entries** — confirm they still reflect current code; add new entries during Phase 1+ as patterns ship | KEEPER |

Each archive action preserves the original file at `99_Archive/<original-path>` with the supersession note in the changelog.

### Phase 0b — DR drafting + new vault docs (KEEPER + QUILL · ~3 hours)

DRs renumbered: DR-036 was already taken (`Client_Subscriptions_Table`). Logging DRs are now DR-037 / DR-038 / DR-039.

| Step | Owner | Deliverable | Output path |
|---|---|---|---|
| 0b.1 | AXIOM + SAGE | DR overlap audit — DR-001 (PII) · DR-020 (email) · DR-022 (layers) · DR-026 (multi-door) · DR-034 (member_access_sources). Surface conflicts before drafting. | (review note in this file) |
| 0b.2 | KEEPER | DR-037 — Observability architecture (3-primitive design) | `13_Decision_Records/DR-037_Observability_Architecture.md` |
| 0b.3 | KEEPER | DR-038 — Event registry standard (AXIOM-gated PRs, code-canonical-vault-mirror sync) | `13_Decision_Records/DR-038_Event_Registry_Standard.md` |
| 0b.4 | KEEPER | DR-039 — Redaction allowlist standard (build-time + runtime backstop) | `13_Decision_Records/DR-039_Redaction_Allowlist.md` |
| 0b.5 | KEEPER | OB-LOG-01 + OB-LOG-02 entries in `open_items.md` | `open_items.md` |
| 0b.6 | QUILL + KEEPER | `Observability_Architecture.md` — full design doc (lives in `07_Logging_Observability/` per vault structure, not `03_Architecture/`) | `07_Logging_Observability/Observability_Architecture.md` |
| 0b.7 | QUILL + KEEPER | `Logger_Trace_Context.md` — ALS pattern, middleware sequence, BullMQ pass-through | `05_Integrations/Logger_Trace_Context.md` |
| 0b.8 | KEEPER | Update `04_Data/Data_Model.md` — schema additions + activity_event + v_trace_timeline | `04_Data/Data_Model.md` |
| 0b.9 | KEEPER | Update `13_Decision_Records/DECISION_LOG.md` index with DR-037/038/039 | `13_Decision_Records/DECISION_LOG.md` |
| 0b.10 | KEEPER | Update `KB_FILE_REGISTRY.md` + `VAULT_SUBSTANCE_MAP.md` for all changes | (registry files) |

### Phase 0c — Process gate restoration (SAGE · 15 min)

Add hard rule to BOT team protocol: **before SAGE convenes on any architectural question, KEEPER must explicitly state "vault read complete — files checked: [list]"**. Same rule already in CLAUDE.md, just unenforced. This makes it a hard gate.

| Step | Owner | Deliverable | Output path |
|---|---|---|---|
| 0c.1 | SAGE + KEEPER | Update `business-operating-team.skill` (or governance.md) with vault-read-first gate | (skill file) |
| 0c.2 | KEEPER | Note rule in `CLAUDE.md` Team Protocol section (already exists at line "Vault-First Question Rule" — strengthen to architecture rulings) | `CLAUDE.md` |

### Phase 0 gate

SAGE approves all of Phase 0a + 0b + 0c → KEEPER files → Phase 1 (code) unblocks.

Drafting style per Daxx: full batch, SAGE filters, only flagged items surface to Daxx.

---

## Build sequence — 12 steps

Each step has its own brief in this folder (`STEP_NN_*.md`). Briefs are self-contained: any agent can pick up a step without context from prior conversations.

| Step | Owner | Title | Brief | Estimated time |
|---|---|---|---|---|
| 1 | ORION + FELIX | Migration: schema additions + activity_event + v_trace_timeline | [STEP_01](STEP_01_migration_schema.md) | 1 hour |
| 2 | NOVA + FELIX | `core/trace-context.js` — ALS wrapper | [STEP_02](STEP_02_trace_context_module.md) | 1 hour |
| 3 | NOVA + FELIX | Refactor `core/logger.js` — auto-read context from ALS | [STEP_03](STEP_03_logger_refactor.md) | 1.5 hours |
| 4 | NOVA + LENS | Express middleware — trace mint on every request | [STEP_04](STEP_04_express_middleware.md) | 1.5 hours |
| 5 | PARSE + NOVA | BullMQ handler context — verified ALS pass-through | [STEP_05](STEP_05_bullmq_context.md) | 1 hour (after PARSE clearance) |
| 6 | NOVA + FELIX | Cron starters — context at process start | [STEP_06](STEP_06_cron_context.md) | 30 min |
| **CHECKPOINT — End of Day 1** | REX + SAGE | Verify steps 1–6 complete and DEPLOY SAFE; trim scope if not | — | 15 min |
| 7 | NOVA + AXIOM | `admin/middleware/activity.js` — universal activity logger | [STEP_07](STEP_07_activity_middleware.md) | 2 hours |
| 8 | CIRCUIT + AXIOM + SAGE | `core/EVENT_REGISTRY.md` — initial taxonomy + redaction allowlist | [STEP_08](STEP_08_event_registry.md) | 2 hours |
| 9 | NOVA + FELIX | Wire activity logging into all admin/operator mutation routes | [STEP_09](STEP_09_route_wiring.md) | 2 hours |
| 10 | NOVA + FELIX | Backfill: setContext for legacy core/adapters log emitters (actor=system) | [STEP_10](STEP_10_legacy_backfill.md) | 1 hour |
| 11 | FELIX | Full deploy-gate validation + benchmark | [STEP_11](STEP_11_validation.md) | 1 hour |
| 12 | SAGE | Final ship gate | [STEP_12](STEP_12_ship_gate.md) | 30 min |

**Critical path:** Steps 1 → 2 → 3 → 4 are sequential and gate everything else. Steps 5 + 6 can run parallel after 3. Steps 7 + 8 can run parallel after 4. Step 9 needs both 7 and 8. Step 10 can run anytime after 3. Step 11 gates Step 12.

---

## Day-1 Checkpoint Protocol (C3 mitigation)

REX runs this at end of Day 1 (or whenever steps 1–6 complete).

**Pass criteria:**
- All steps 1–6 marked ✅
- 90/90 deploy-safe tests passing
- ALS propagation test harness (built in step 2) demonstrates trace ID survives Express → DB → Kisi → log path
- No FELIX findings open

**If pass:** Continue to steps 7–12 as scheduled.

**If fail:** REX escalates to SAGE. Scope trim option:
- Ship steps 1–6 only (universal context + auto-tagged logs in existing tables)
- Defer steps 7–10 (activity_event wiring) to a follow-up sprint
- This still solves the trace propagation problem and gives the unified-timeline view; only the action-record granularity is deferred
- HOG launch unblocked, follow-up sprint scheduled within 2 weeks of HOG launch

---

## Risk register (from STEEL pressure test)

| ID | Risk | Severity | Mitigation | Status |
|---|---|---|---|---|
| C1 | ALS propagation traps in callback-style libs | Real | Test harness in step 2; explicit wraps as needed | Mitigated |
| C2 | OTel migration debt later | Hypothetical, distant | Forward-compatible field shape | Mitigated |
| C3 | 11 moving parts in 3 days | Real | Day-1 checkpoint + scope-trim path | Mitigated |
| M1 | External HOG deadline conflict | Conditional | PC-1 confirmation gate | Awaiting PC-1 |
| M2 | Audience doesn't exist yet | Misframed | OB-LOG-02 UI consumes the foundation | Dismissed |
| M3 | AI-readability speculative | Partial | Narrow EVENT_REGISTRY scope | Mitigated |
| E1 | Solo operator capacity | Misframed | Daxx isn't writing the code | Dismissed |
| E2 | Over-engineering for scale | Worth weighing | Non-goals enforce restraint | Mitigated |
| E3 | Redaction landmine | **High** | **AXIOM gate + runtime regex backstop** | Mitigated (mandatory) |
| E4 | ALS performance tax | Bounded | FELIX benchmark in step 11 | Mitigated |

---

## Open items spawned by this sprint

| OB ID | Title | Trigger |
|---|---|---|
| OB-LOG-01 | Audit existing logging UI surfaces (Previewer/Operator/Owner views) | Sprint complete |
| OB-LOG-02 | Build unified observability UI (consumes v_trace_timeline) | OB-LOG-01 audit complete |

---

## Handoff sequence (REX coordinates)

```
PC-1, PC-2, PC-3 confirmed
    ↓
KEEPER files DR-036/037/038 + open items (Phase 0)
    ↓
SAGE approves DR drafts
    ↓
PARSE verifies BullMQ + ALS interaction (parallel — 24h SLA)
    ↓
ORION drafts migration (Step 1)
    ↓
FELIX validates migration → ORION runs against Railway DB
    ↓
NOVA stages branch
    ↓
Steps 2-6 sequential build
    ↓
End-of-Day-1 Checkpoint (REX runs)
    ↓
Steps 7-10 (parallel where possible)
    ↓
Step 11 — FELIX deploy-gate
    ↓
Step 12 — SAGE ship gate
    ↓
Merge to main, Railway deploys
    ↓
KEEPER session-close audit
    ↓
OB-LOG-01 begins
```

---

## Communication protocol during sprint

- **Per-step kickoff:** Owner reads their `STEP_NN_*.md` brief in full before starting. Brief is self-contained — no prior context needed.
- **Per-step completion:** Owner posts to chat: `STEP NN COMPLETE — <one-line summary> — <test status>`. REX updates this plan's status table.
- **Blockers:** Any blocker → REX immediately. REX escalates to SAGE if it threatens the day-1 checkpoint or final ship gate.
- **Scope changes:** Forbidden mid-step without REX + SAGE approval. Scope creep is the most likely failure mode.

---

## Status table (REX updates as sprint runs)

| Phase | Step | Owner | Status | Started | Completed | Notes |
|---|---|---|---|---|---|---|
| Pre | PC-1 | Daxx | ⚪ | — | — | |
| Pre | PC-2 | Daxx | ⚪ | — | — | |
| Pre | PC-3 | Daxx | ⚪ | — | — | |
| 0 | Phase 0 docs | KEEPER + QUILL | ⚪ | — | — | |
| 1 | Migration | ORION + FELIX | ⚪ | — | — | |
| 2 | trace-context.js | NOVA + FELIX | ⚪ | — | — | |
| 3 | logger refactor | NOVA + FELIX | ⚪ | — | — | |
| 4 | Express middleware | NOVA + LENS | ⚪ | — | — | |
| 5 | BullMQ context | PARSE + NOVA | ⚪ | — | — | PARSE clears first |
| 6 | Cron context | NOVA + FELIX | ⚪ | — | — | |
| — | Day-1 checkpoint | REX + SAGE | ⚪ | — | — | |
| 7 | Activity middleware | NOVA + AXIOM | ⚪ | — | — | |
| 8 | EVENT_REGISTRY | CIRCUIT + AXIOM + SAGE | ⚪ | — | — | |
| 9 | Route wiring | NOVA + FELIX | ⚪ | — | — | |
| 10 | Legacy backfill | NOVA + FELIX | ⚪ | — | — | |
| 11 | Validation | FELIX | ⚪ | — | — | |
| 12 | Ship gate | SAGE | ⚪ | — | — | |
| Post | OB-LOG-01 | NOVA + FORGE + LENS | ⚪ | — | — | |
| Post | OB-LOG-02 | FORGE + IRIS + LENS + REAM | ⚪ | — | — | |

Legend: ⚪ pending · 🟡 in progress · 🟢 complete · 🔴 blocked

---

## Reading order for any agent stepping into this sprint cold

1. This file (`00_SPRINT_PLAN.md`) — what's being built and why
2. `13_Decision_Records/DR-036.md` — observability architecture decision (after Phase 0)
3. `03_Architecture/Observability_Architecture.md` — full design (after Phase 0)
4. The specific `STEP_NN_*.md` brief for the work being picked up
5. `core/EVENT_REGISTRY.md` if touching event names (after Step 8)

No agent should pick up a step without reading items 1, 4, and any DR referenced in their step brief.
