# Logging Foundation Sprint — Handoff Package

**For any agent (or human) picking up this work cold.**

---

## Read order

1. **`00_SPRINT_PLAN.md`** — what's being built, why, how, sequence, status. Always start here.
2. The specific **`STEP_NN_*.md`** for the work being picked up.
3. (Optional) `13_Decision_Records/DR-036.md` after Phase 0 is complete — the locked architecture decision.

If you're returning mid-sprint, read `00_SPRINT_PLAN.md` first to find current status, then jump to the active step's brief.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `README.md` | This file — entry point and index |
| `00_SPRINT_PLAN.md` | Master plan: scope, sequence, mitigations, status |
| `STEP_01_migration_schema.md` | Migration: schema additions + activity_event + v_trace_timeline |
| `STEP_02_trace_context_module.md` | `core/trace-context.js` — ALS wrapper + propagation tests |
| `STEP_03_logger_refactor.md` | Refactor `core/logger.js` to auto-read context + redaction |
| `STEP_04_express_middleware.md` | Express middleware — trace + actor on every request |
| `STEP_05_bullmq_context.md` | BullMQ job handler context pass-through (PARSE-gated) |
| `STEP_06_cron_context.md` | Cron starters — context at process start |
| `STEP_07_activity_middleware.md` | `recordActivity()` helper |
| `STEP_08_event_registry.md` | `core/EVENT_REGISTRY.md` + redaction-allowlist.json |
| `STEP_09_route_wiring.md` | Wire `recordActivity()` into every mutation route |
| `STEP_10_legacy_backfill.md` | Legacy emitter audit + process-handler fixes |
| `STEP_11_validation.md` | FELIX final validation + benchmark |
| `STEP_12_ship_gate.md` | SAGE final ship ruling |

---

## Critical-path summary

```
Pre-conditions (Daxx confirms 3 items)
    ↓
Phase 0 — KEEPER files DRs + vault docs
    ↓
Step 1 (migration) → Step 2 (trace-context) → Step 3 (logger refactor) → Step 4 (Express MW)
    ↓
Steps 5 + 6 (parallel) — BullMQ + cron context
    ↓
🚧 DAY-1 CHECKPOINT — REX runs, scope-trim path available 🚧
    ↓
Steps 7 + 8 (parallel) — activity middleware + EVENT_REGISTRY
    ↓
Step 9 — route wiring (depends on 7 + 8)
Step 10 — legacy backfill (parallel anytime after 3)
    ↓
Step 11 — FELIX validation
    ↓
Step 12 — SAGE ship gate
```

---

## Owners at a glance

| Agent | Steps owned |
|-------|-------------|
| **SAGE** | Phase 0 approvals · Day-1 checkpoint · Step 8 final approval · Step 12 ship gate |
| **REX** | Coordination · Day-1 checkpoint operator · Status table updates |
| **NOVA** | Steps 2, 3, 4, 5, 6, 7, 9, 10 (engineering) · Step 11 benchmark |
| **ORION** | Step 1 (migration) · Step 5 (verifies query patterns) |
| **AXIOM** | Step 7 (recorder review) · Step 8 (registry audit) · Step 9 (PII review) |
| **CIRCUIT** | Step 8 (AI-readability review) |
| **FAULT** | Risk register (already filed in `00_SPRINT_PLAN.md`) — consult on benchmark concerns |
| **PARSE** | Step 5 prerequisite (BullMQ + ALS verification, 24h SLA) |
| **FELIX** | Validates every step · Owns Step 11 |
| **LENS** | Verifies steps 4, 9, 11 — visual + endpoint checks |
| **KEEPER** | Phase 0 · Step 8 file-management · Step 11 vault audit · Step 12 session-close |
| **QUILL** | Phase 0 vault docs · Step 12 changelog entry |

---

## What if the sprint stalls?

Use the day-1 checkpoint scope-trim path defined in `00_SPRINT_PLAN.md`:

> Ship steps 1–6 only (universal context + auto-tagged logs in existing tables). Defer steps 7–10 (activity_event wiring) to a follow-up sprint within 2 weeks of HOG launch.

This still solves the trace propagation problem and gives the unified-timeline view; only the action-record granularity is deferred. HOG launch unblocked.

REX makes this call jointly with SAGE.

---

## Open items spawned by this sprint

After Step 12 ships:

- **OB-LOG-01** — Audit existing logging UI surfaces (Previewer/Operator/Owner views). Output: keep/improve/remove/merge recommendation per surface.
- **OB-LOG-02** — Build the unified observability UI consuming `v_trace_timeline`. Pre-condition: OB-LOG-01 complete.

These are listed in `00_SPRINT_PLAN.md` and will be filed in `open_items.md` during Phase 0.

---

## Last updated

2026-04-27 by REX (initial handoff package creation)
