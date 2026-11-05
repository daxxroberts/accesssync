# Sweep resync — Phase 3c (2026-11-05)

**Branch:** `fix/sweep-resync`, on top of `fix/plan-mapping-kisi-sync` (it moves that branch's door
functions into core, so it must merge after it).
**Status:** built and tested; not merged; nothing pushed to main. Needs the SAGE gate and Daxx's
push authorization.

## The rule (Daxx, 2026-11-05)

> "All those users need to be updated in Kisi and need to be in sync with their plan mappings."
> "If for some reason the delete fails, the sweep catches that that person should have been deleted."

The 6-hour reconcile sweep, and the dashboard's **Sync now** button (same `_syncClient`), may now:

| # | Situation | Action | Gate | Kill switch |
|---|---|---|---|---|
| 1 | A member on a live plan, paying for it in Wix (a seat: its holder), is missing one of the plan's doors in Kisi | Give that door (`grantMappingGroup`, the Plan Mapping path) | none (a grant, not a removal) | `RECONCILE_DOOR_REPAIR=off` |
| 2 | A door AccessSync gave for a plan that no longer includes it (taken off, plan switched off / no doors) is still on in Kisi | Take that door off (`revokeMappingSource`: Kisi first, C-4). Account and other doors stay | `auto_revoke_mode='on'`, no anomaly; **held if more than half the members** (alert `sweep_door_removal_held`) | `RECONCILE_DOOR_REMOVAL=off` |
| 3 | Wix says a plan ENDED (both reads) and our removal never finished — including one plan of a member who still pays for another | Queue the normal revoke (`reconciliation.wix_not_paying`) | same armed policy as holder lapse: mode `on`, strike clock 3 sweeps / 48 h, mass cap, no anomaly | `RECONCILE_WIX_ABSENCE_REMOVAL=off` |
| 4 | A member parked `removing` > 1 h with no door left (the Kisi account delete failed and its retries ran out) | Queue the revoke the retry design re-runs → `finalizeRevoke` again (DR-045 guard) | mode `on`, no anomaly | `RECONCILE_FINISH_REMOVAL=off` |

Never: a user deleted for a door change; a group role given to a Kisi owner / administrator; a
door staff gave by hand in Kisi (no AccessSync source row) touched; a declined, pending or
unrecognised payment treated as a removal; ABSENT (no order found at all) armed. A DR-045 guard
refusal leaves the member `inactive`, never `removing`, so rule 4 never retries a deliberate
"keep this account".

## What changed

- `core/plan-door-sync.js` (new): `grantMappingGroup`, `revokeMappingSource`, `raiseDoorAlert`,
  `OTHER_PLAN_KEEPS_DOOR_SQL` moved unchanged out of `admin/routes/operator.js`, plus
  `resolveDoorAlerts` — the sweep closes the save's `door_grant_failed` / `door_swap_held` /
  `door_removal_failed` alert once it has fixed that member's door. DR-023 ratchet updated
  (operator.js 2 → 0, plan-door-sync.js 2; no new write).
- `core/reconciliation.js`: `_planDoorCheck` (reads plans from `plan_mapping_groups` — a plan is
  live when on with ≥ 1 door, the same rule as Plan Mapping's `planIsLive` — and compares every
  AccessSync plan row with Kisi's pairs); the execution block after the removal decision; 3B now
  also proposes a paying member's ENDED plan; `isArmedRemoval` arms ENDED WIX_ABSENCE alongside
  HOLDER_LAPSE in one armed batch; parked-`removing` restart; repair proposals recorded
  `decision='repaired'` (no alert) or `hold_reason='repair_failed'`; `toIsoOrNull` reads a Date from
  another realm (the real-DB tests' worker thread) instead of treating it as no clock.
- `core/grant-revoke.js` / `core/member-mailer.js`: `reconciliation.wix_not_paying` added to the
  DR-050 billing-cancel and member "access ended" email allow-lists (the webhook's removal never
  finished, so neither had happened). `reconciliation.finish_removal` is on neither.
- `admin/routes/operator.js` `/sync/run` returns `doorsAdded`, `doorsRemoved`, `doorRemovalsHeld`;
  `admin/views/pages/dashboard.ejs` shows them ("3 doors added · 2 doors removed", "door removals
  held — see Alerts").
- **Bug fixed in passing:** after a sync that worked, the dashboard called `loadLiveData()`, a named
  IIFE whose name exists only inside itself — the ReferenceError sent every successful Sync now to
  the catch: label "Sync failed", toast "Sync failed — network error". Now a named function run
  once on load.
- Alert copy: `sweep_repair_pending` (repair is on now: it fires only when the attempt failed or the
  Kisi user is gone), the removal-pending note ("AccessSync double-checks before it removes
  anyone"), new `sweep_door_removal_held`.
- Events (EVENT_REGISTRY.md / .json): `reconciliation.door_check_complete` (persisted),
  `reconciliation.ended_plan_armed` (persisted), `reconciliation.removal_restarted` (persisted),
  `reconciliation.door_check_skipped`, `…door_check_failed`, `…ended_plan_removal_failed`,
  `…removal_restart_failed`, `…parked_removals_read_failed`, `operator.sync.door_alert_resolve_failed`.

## SAGE gate review (2026-11-05) — findings and fixes

An independent review of the first cut found these; all fixed, each with a real-DB test:

1. A plan that is **on with no door rows** (a legacy mapping the grant resolver still serves from
   `plan_mappings.hardware_group_id`, a plan whose last door was just taken off, or a Plan Mapping
   save caught between its DELETE and INSERT of `plan_mapping_groups`) read as "switched off": every
   door on it would have come off. Now left alone entirely (`plansWithoutDoors` in the log).
2. The mass cap missed a door lost through **two plans at once** (each row "kept" by the other).
   Now counted per (member, door): lost only when no non-leftover row gives it; population = members
   holding, in Kisi, a door a row of theirs gives. `doorsRemoved` counts doors Kisi lost.
3. **Races with a save**: every door is re-read just before it is given or taken
   (`_doorStateNow`) — plan still live and the door still (or no longer) on it, member still active
   and on the plan. (The save's junction rewrite is still two statements; the re-read covers it.)
4. A member held on the old door by a swap (`door_swap_held`), seats included, was not "on the
   plan" and was never finished. Now on the plan by any active row under it (the save's
   `membersOnPlan`); the new door is given, then the old one taken in the same sweep.
5. The owner / administrator check, and the DR-051 seat check, **failed open** on a read error.
   Now fail closed: no door that sweep.
6. The door check offered doors the grant path never gives: health `not_found`, or a location
   whose AccessSync billing lapsed (DR-027). Now filtered like core/plan-mapping-resolver.js.
7. A paying member's other plan that is declined / pending / has no order kept its removal clock
   running. Now cleared every sweep (CLEAR (c)).
8. A Kisi account delete that keeps failing was restarted every 6 h forever and wrote a
   "cancelled" history row each time. Now at most 3 restarts, and no history row.
9. Alerts the sweep answered (`sweep_repair_pending` after a door is given back;
   `sweep_removal_pending` / `revoke_holder_lapse_pending` after the removal is queued) are now
   resolved; alert copy no longer claims a repair was attempted when it was not, nor promises a
   support override that does not exist.

## Day-one impact at House of Gains (read-only check, 2026-11-05)

Wix (one GET walk of /pricing-plans/v2/orders, 177 orders) against the 129 active primary plan
rows: **0** new ended-plan proposals for members still paying another plan, **0** ended plans on
non-paying members, **0** clocks ripe; 4 declined / pending stay held (never a removal).


0 members parked `removing`; 0 leftover door rows (all 155 active rows are on a current door);
last Pass 3: 0 drifted, 0 repair pending; 0 active rows whose only billing is cancelled. The first
armed sweep should change nothing — the rules act only when a save or a removal fails later.

## Tests

`npm run test:deploy` green (154 suites, 3070 tests). New `test/p1-critical-path/real-db-sweep-resync.test.js` (25 — 15 below plus one per review finding; PGlite +
fake Kisi + the real Plan Mapping route and queue worker): add-door failure fixed and its alert
closed; staff-removed door put back; Kisi still refusing → one alert; never for an administrator,
a declined payment, or with repair off; remove-door failure fixed with the other door and account
kept; plan switched off; C-4 shared door; mode not `on` holds; more than half the members holds +
alert; hand-added Kisi door untouched; remap in progress never strips the old door; stuck account
delete re-run after an hour (not before); failed door removal finished after 3 sweeps / 48 h; one
plan of two ended; declined payment never removed.

## Open / for SAGE and Daxx

- **Phase gate:** this arms the Reconciliation Builder's repair phase (3a) and the ENDED part of 3b
  for a member's own plan. KEEPER: record as a decision (with the Sep-10 rules) after Daxx's OK.
- Production check after deploy: watch `reconciliation.door_check_complete` and
  `reconciliation.ended_plan_armed` in `diagnostic_log` for the first sweeps (expect all zeros).
- Known, not changed here: a paying member whose Kisi **user** was deleted in the Kisi dashboard
  stays alert-only (`sweep_repair_pending`) — re-creating an account a gym deleted is a product call.
- Known, not changed here: Pass 1(b) still falls back to `plan_mappings.hardware_group_id` for a
  mapping with no `plan_mapping_groups` rows (a plan whose last door was taken off), inserting a
  role-less row; harmless (the door check ignores role-less rows and treats the plan as not live).
- Known, not changed here: family sub-members are not restored when a plan is switched back on
  (from `fix/plan-mapping-kisi-sync`).
- A Kisi account delete that keeps failing is restarted once per sweep (6 h), each failure visible
  on the Errors page as before.
