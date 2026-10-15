# AccessSync Owner Hub — Proposal and Bug Fixes

**Date:** 2026-10-15
**Prepared by:** SAGE and the BOT team. LUMEN+REED reviewed the owner's jobs, FAULT the failure modes, MARGIN+SCOUT the business signals, and LENS+FORGE the UX and emails.
**Branch:** `claude/error-visibility-actions` (not merged, not deployed)

---

## 1. Summary

The BOT team ran four read-only reviews in parallel, then SAGE cut them down to one simple design.

**What the owner hub answers:**

> **"Is AccessSync working for every gym — and is there anything only I can fix?"**

Everything on the page either answers that or is removed. Member-by-member detail belongs to each gym, on their own Errors page and in their own email.

**Daxx's rules (2026-10-15):**
- The owner hub shows **real access problems for each customer's AccessSync service**, not member-level detail.
- **Gym emails go to that gym's own notification email**, as set in that gym's settings. For House of Gains this is currently Daxx's address, so he keeps receiving them until the gym's setting is changed.
- **Owner emails go to the AccessSync owner address** (`ACCESSSYNC_OWNER_NOTIFICATION_EMAIL`).
- Alerts name the real member and the real location, never "one of your locations" (already built on this branch).

---

## 2. The proposal: a problems inbox

### 2.1 Layout

1. **Verdict line, first thing on the page**
   - "All 3 gyms OK"
   - or "1 of 3 gyms needs you · 1 waiting on the gym"

2. **One row per gym that isn't OK.** Each row shows:
   - the gym
   - what's broken
   - who acts: **You** or **The gym**
   - since when
   - a button that opens that gym

   Rows that need **you** come first, then the oldest first.

3. **Healthy gyms** fold into small chips: `✓ House of Gains`. Tapping one opens that gym's details.

4. **Platform row, only when something is wrong:** database, job queue / worker, background jobs that stopped (nightly sync, Kisi key check, day-pass sweep), and errors not tied to any gym.

The page grows with the number of **problems**, not the number of gyms, so it works the same at 1 gym or 50.

### 2.2 The only reasons a gym can show up

| Reason shown | Who acts | Where the data comes from |
|---|---|---|
| Door key rejected by Kisi (or not checked in 24h) | The gym (key) / You (the check isn't running) | `connector_subscriptions.key_last_error`, `key_last_verified` |
| Syncing with Wix is failing (last run aborted, or no **successful** run in 13h amber / 26h red) | You or the gym, depending on the abort reason | `reconciliation_run.status`, `abort_reason` |
| Purchases have stopped arriving (silent compared with this gym's own normal gap) | You / the gym | `clients.last_webhook_at`, `webhook_log` |
| N members can't get in: AccessSync must fix | You | `error_queue` (guidance owner = accesssync) + members stuck more than 24h |
| N members can't get in: the gym must fix, **ignored for more than 48h** | The gym (you nudge) | `error_queue` (owner = gym), age of the oldest |
| Paying members parked with no door (location lapsed / door group gone) | You / the gym | new: raised as an error (bug 3 below) |
| Setup stalled. Steps: installed → key verified → plans mapped → first sale → first door | You (onboarding) | `clients`, `connector_subscriptions`, `plan_mappings`, `webhook_log`, `member_access_log` |

### 2.3 Removed from the owner hub

| Item | Where it goes / why |
|---|---|
| Removals waiting for the gym's decision (sync alerts) | The gym's Errors page; it's the gym's business decision |
| "Diagnostics" row | Removed. It's jargon, never turns red, and has no action attached |
| "Latest reconcile Xh ago across all clients" | Removed. A maximum across all gyms hides one stale gym |
| Wix administrators list | "Manage gyms" tab |
| Clients management list (archive / delete / setup link) | "Manage gyms" tab; it's account management, not health |
| Logged-in strip | Removed. Hardcoded, tells you nothing |

---

## 3. Emails

| Email | Goes to | When | What it says |
|---|---|---|---|
| **Owner daily** | AccessSync owner address | Every day, **including an all-clear**, so a missing email always means something is wrong | Subject = the verdict ("All 3 gyms OK" / "1 of 3 gyms needs you"). One line per gym problem: reason, who acts, since, link. Counts only, **never member names**. |
| **Owner immediate** | AccessSync owner address | Only when: (a) access is blocked and only AccessSync can fix it, (b) a gym's door key fails, (c) the platform is down | Grouped per gym, per problem type, per day |
| **Gym daily** *(new; today only the owner gets a digest)* | That gym's notification email | Only when something is open | Member-level detail: who didn't get access and why, removals waiting for their decision, missing door groups. Each has a link to their Errors page. |
| Gym "action needed" *(exists, unchanged)* | That gym's notification email | Per problem (already deduped and throttled) | As today |

Email fixes found by LENS+FORGE:
- The current digest is written as if to a gym ("dismiss it in your dashboard"), but only the owner receives it.
- The Kisi key alert goes to the gym, and the owner gets it only when the gym has no email set. Add an owner copy.
- The suspicious-webhook (HMAC) alert names no gym, and its link opens an empty Errors page.

---

## 4. Bug fixes (fix first; they don't depend on the redesign)

FAULT found these, and SAGE confirmed them in the code. Live data was checked read-only on 2026-10-15.

### Bug 1 — A failed sync shows as healthy

- **What happens:** the owner hub judges sync health by the **latest sync attempt**, whatever its outcome. A sync that aborted (broken Wix key, Kisi outage, held mass-removal) still counts as "fresh", so the card stays green.
- **Where:** `admin/routes/system-health.js:100` (per gym) and `:107` (aggregate) use `MAX(started_at)` from `reconciliation_run` with no status filter.
- **Evidence:** `reconciliation_run` records `status` (`success` / `aborted`) and `abort_reason` (e.g. `wix_api_unavailable`, `hardware_api_unavailable`). Live: 29 runs in the last 14 days, all `success`, so it isn't happening today, but nothing would show it if it did.
- **Impact:** a whole gym gets no catch-up grants or repairs while the hub says everything is fine.
- **Fix:** freshness comes from the last **successful** run per gym. If the latest run aborted, show the reason in plain words ("Wix couldn't be read", "Kisi didn't respond") and who acts.
- **Test:** a gym whose latest run aborted reads amber/red with the reason, even though its last run started 1h ago.

### Bug 2 — A purchase can be lost if queuing it fails

- **What happens:** when a Wix purchase arrives, AccessSync marks it "processed" **before** putting it on the job queue. If queuing fails (e.g. Redis is down), Wix gets an error and retries, but the retry is rejected as a duplicate, so the purchase never becomes a job.
- **Where:** `core/webhook-processor.js:118` (`_markEventProcessed`, writes `processed_event_ids`) runs before `eventQueue.add` at `:180` (grant) and `:189` (revoke).
- **Impact:**
  - **Sign-ups** are delayed, not lost: the 6-hourly sync finds paying members without access and grants them.
  - **Cancellations** aren't re-raised: they wait as a held removal for the gym's decision.
  - The owner hub shows nothing; webhooks look "active".
- **Fix:** if `eventQueue.add` throws, remove the `processed_event_ids` row before returning the error, so Wix's retry goes through. BullMQ's `jobId` (`grant-<eventId>`) already prevents a double job if both succeed.
- **Test:** when the enqueue throws, the processed row is removed and the next delivery of the same event is enqueued.

### Bug 3 — Paying members silently parked with no door

- **What happens:** when a gym's location subscription has lapsed, or a door group has been marked unhealthy (deleted in Kisi), the plan lookup returns **no door groups**. The member is parked with no access. Nothing is written to the error list, no alert is raised and no email goes out.
- **Where:**
  - `core/plan-mapping-resolver.js:44–66` excludes a mapping when its location has no active `billing_subscriptions` row (`l.id IS NULL OR bs.id IS NOT NULL`) or its door group's `health_status` isn't `ok`.
  - `core/queue-worker.js:641` then parks the member (`parkPendingHardware(memberId, tenantId, [])`) with only an info log, `queue.grant.parked.no_mapping`. The comment says the signal "lives in config_alert_log", but no alert is written.
  - `SUBSCRIPTION_LAPSED` guidance exists (`core/error-guidance.js:95`), but no code ever raises it.
- **Impact:** a member pays and can't get in, and nobody is told.
- **Fix:** the resolver says *why* it found nothing (location lapsed / door group unhealthy / plan has no group yet). For the first two, raise a dead-letter (error list + email) with the right owner: lapsed → AccessSync (`SUBSCRIPTION_LAPSED`); door group gone → the gym ("choose a door group that still exists"). A plan with no group yet (new gym setting up) stays parked but shows on the owner hub as "setup stalled".
- **Test:** a purchase for a lapsed location produces an error row with `SUBSCRIPTION_LAPSED` and an email; a deleted door group produces a gym-owned error.

### Bug 4 — The Kisi key check never runs

- **What happens:** the check that each gym's Kisi key still works (and that its door groups still exist) is supposed to run every 6 hours, but nothing schedules it.
- **Where:**
  - `core/hardware-health-check.js` (header: "every 6 hours via Railway Cron: `node core/hardware-health-check.js`"; exports `runHealthCheck` at `:505`).
  - The app's own scheduler (`admin/server.js:281/304` reconcile, `:319/337` day-pass sweep) does not run it.
- **Evidence:** live `connector_subscriptions.key_last_verified` is NULL, and there are no health-check results in `diagnostic_log` in 60 days. The Railway cron job doesn't exist.
- **Impact:** a revoked or rotated Kisi key is only discovered when a member's grant fails. Deleted door groups aren't marked.
- **Fix:** run it from the app's own scheduler every 6 hours, like the sync. That needs no extra Railway service. Ship it **together with bug 3**: once the check marks a deleted door group, bug 3's silent parking would otherwise hide affected members.
- **Test:** the scheduler arms the key check; a failing key writes `key_last_error` and appears on the owner hub.

### Bug 5 — Members stuck partway through are invisible

- **What happens:** members can get stuck in an in-between state (waiting for their identity to be confirmed, mid-recovery, or a door assignment marked failed). The owner hub never counts them.
- **Where:** `member_access.status` in (`pending_identity`, `recovery_pending`, `in_flight`) and `member_access_sources.status` in (`failed`, `pending_hardware`, `pending_start`). Neither is read by `admin/routes/system-health.js`.
- **Evidence (live):** 1 member in `pending_identity` since 2026-10-05 (10 days); 1 door assignment `failed` since 2026-05-16 (5 months).
- **Fix:** count anything stuck for more than 24h per gym under "N members can't get in — AccessSync must fix". **Also investigate the two live cases.**
- **Test:** a member stuck in `pending_identity` for 25h turns the gym's row on; one stuck for 2h doesn't.

### Bug 6 — An amber row sits under a green "everything's fine"

- **What happens:** errors not tied to any gym appear as an amber "Not tied to a client" row directly below a green "Nothing needs your attention" verdict.
- **Where:** `admin/routes/system-health.js:365` computes `platform_errors_24h`, but the aggregate verdict (`:383`) only includes `unassigned_open_errors`.
- **Fix:** move it into the platform row, which only appears when the count crosses a threshold, and include it in the verdict when it does.
- **Test:** platform errors above the threshold make the verdict amber; below it, nothing shows.

### Bug 7 — The sync schedule for every gym is decided by one gym (must fix before client #2)

- **What happens:** the sweep decides whether it's time to run by looking at **one** client's last sync time and interval, then syncs all clients.
- **Where:** `core/reconciliation.js` (recurrence gate: `SELECT last_sync_at, … FROM clients WHERE status = 'active' ORDER BY last_sync_at DESC NULLS LAST LIMIT 1`).
- **Impact:** with 2+ gyms on different intervals, one gym's setting controls everyone's cadence.
- **Fix:** decide per gym; sync each gym whose own interval has elapsed.

### Smaller findings (logged)

- Webhooks rejected for a bad signature are stored with no gym, so a secret mismatch looks like "no sales" rather than "broken".
- `lockdown_detected` alerts are inserted every sync with no de-duplication.
- No `operator.login` event exists, so "the gym hasn't opened AccessSync in 14 days" can't be measured yet.

---

## 5. Deferred, and why

| Item | Why it waits |
|---|---|
| Plan, monthly revenue, renewal per gym | The data isn't trustworthy yet: `as_subscription_terms` and `as_client_subscriptions` are empty, and prices conflict ($199 Pro in CLAUDE.md, $30/$60/$150 in DR-008, "Connect" on House of Gains' record). **Needs Daxx's pricing decision (P7).** Until then the hub shows nothing about billing rather than guess. |
| Value line per gym ("265 members given access automatically in 90 days, about 6 seconds from purchase to door") | The data is good (`member_access_log`, `webhook_log`), and it's strong renewal and sales material. It comes after the inbox, on the gym's detail view. |
| Trends and churn signals (member count falling, gym not logging in) | Need history and an `operator.login` event. Phase 4. |

---

## 6. Decisions needed from Daxx

| # | Decision | Status |
|---|---|---|
| P2 | Where gym emails go | **Decided 2026-10-15:** the gym's own notification email, from that gym's settings |
| P7 | Pricing: which is right for House of Gains and future gyms? ($199 Pro per location, DR-008's $30/$60/$150, or "Connect") | Open; blocks the billing view |
| P1 | Is `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` set in Railway (Core Engine and Admin Hub)? The owner daily email depends on it. | Open |
| P6 | Set `DB_POOL_MAX` in Railway (Core Engine 6, Admin Hub 4, scheduled jobs 3) | Open |

---

## 7. Order of work

1. **Bug fixes 1–7**, each with tests. 3 and 4 ship together; 7 before client #2.
2. **Owner hub problems inbox** + "Manage gyms" tab.
3. **Emails:** owner daily (with all-clear) + gym daily to the gym's notification email.
4. **Later:** value line per gym, billing view once P7 is decided, trends.

---

## 8. Already on the branch (not yet deployed)

- The gym's Errors page shows open sync alerts in two groups ("Needs attention", "Waiting for your decision"), each with **Mark handled**. Marking a held removal handled keeps it quiet for 30 days.
- Every alert names the real member and the real location; "one of your locations" is gone everywhere.
- Day-pass link "already gone" is no longer logged as an error.
- Pop-up messages are readable in dark mode on every gym page.
