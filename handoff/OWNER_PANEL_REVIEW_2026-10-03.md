# Owner panel review — panel vs. real activity (2026-10-03, ~11:00 UTC)

**How this was done.** The live Railway hosts are blocked from this sandbox, so I ran the **real** `admin-panel.ejs`, the **real** `/admin/clients`, `/admin/system-health`, `/admin/wix-admins` routers and the real owner auth in Chromium. Only `db.query` was faked, answering from a **read-only snapshot of production** (Supabase `gklgwyrnkedebyulrclv`, taken 11:00:07 UTC, clock frozen to it). Ground truth came from separate read-only queries on the raw tables. Nothing was written to production.
Screenshots: `<scratchpad>/owner-panel/panel-desktop.png`, `panel-320.png`. Harness: `<scratchpad>/owner-panel/run.js`.

## What the panel shows
- Administrators: 1 (daxxroberts@gmail.com · House of Gains · OWNER · last seen 21h ago · 28 sessions)
- System Health: **Degraded** — House of Gains **AMBER**: Reconcile fresh (1h) · Webhooks active (88 today) · Errors clean · Diagnostics "238 warn/24h"; Supabase DB probe 0ms, 7 slow queries/24h
- Clients: 1 (House of Gains, active) — "73 members (59 active)", last sync 1h ago
- New in this deploy: **New client** button and **Setup link** per card render and fit at 320px.

## What is actually happening vs. what the panel says

| # | Panel says | Reality (raw tables) | Verdict |
|---|---|---|---|
| 1 | Reconcile fresh, 1h ago | `reconciliation_run`: runs 10-01 23:13, 10-02 11:13, 10-02 23:13, 10-03 09:54, all `success` | Matches |
| 2 | Webhooks active, 88 today | 88 in last 24h; last event 03:46 today; 7-day volume 6/6/28/7/38/51/82/29 per day; all `accepted/new`, none rejected | Matches ("today" = rolling 24h, not calendar day) |
| 3 | Last sync 1h ago | `clients.last_sync_at` 09:54 | Matches |
| 4 | **Errors: Clean** | **Fixed on branch `claude/error-visibility-actions`.** 3 × `QUEUE_JOB_EXHAUSTED` ("Non-retryable hardware error (422): Kisi 422: unknown") in the last 24h, most recent 09:54:33. `member_access_sources` has 1 `failed` row. Every one of the last 4 reconcile runs reports `grants_queued=1`: **the same grant looks stuck and is re-queued and fails on every run.** `error_queue` has 0 open rows (only 2 old resolved ones, June). | **Gap.** An exhausted job never reaches `error_queue`, so the card the owner watches says Clean while a member's door grant is failing. |
| 5 | Diagnostics: 238 warn/24h (amber) | Correct for HOG-tagged rows. But another **353 warns and 28 errors in the same 24h have `client_id = NULL`** (22 × `KISI_RESPONSE_ERROR`, 3 × `HARDWARE_VALIDATION_ERROR`, 31 × `WIX_PARSE_UNPAID_ORDER_DROPPED`, scheduler noise) | **Gap.** Un-attributed rows are invisible to every per-client card, including the 22 Kisi errors. |
| 6 | Errors/Diagnostics never red | The red rule is `error_count_1h > 0`. The newest errors were 09:54, 66 min before the snapshot, so the panel went back to amber/green within the hour even though the failure repeats every reconcile. | Design gap: a repeating failure only flashes red for 60 min after each run. |
| 7 | 73 members (59 active) | `member_access`: 59 active + 5 inactive + **9 deleted** = 73. The 9 are soft-deleted sub-members (DR-044). | **Gap.** "Members" includes deleted people; real members ≈ 64. |
| 8 | (not shown) | **Correction (AXIOM, verified):** Kisi 61 vs Wix 49 is NOT a leak. Wix counts paying primaries; Kisi counts sub-members too. Expected Kisi access = 47 primaries + 12 active sub-members = 59 (the main dashboard's *Active Members*), leaving 2 unexplained, drawn from 10 people with a stored Kisi user but no active plan (2 released-seat holders, 1 old test member, 1 inactive sub, 6 deleted subs). Needs one live Kisi lookup to settle; no evidence of anyone keeping access without paying. House of Gains is `auto_revoke_mode='dry_run'`, so removals are off: the open question is whether a sub-member loses access when the holder lapses (untested). | Open — needs a Kisi read |
| 9 | Supabase DB: 0ms, 7 slow queries | `DB_SLOW_QUERY` ×7 in 24h | Matches. Note "0ms" is the frozen-clock harness, not a real latency. |
| 10 | Administrators: 1 | `wix_admin_seen`: 1 row (owner, last seen 10-02 13:38). No other Wix user has ever opened it. | Matches. Staff/co-admins will start appearing after the open-to-dashboard-users change deploys. |
| 11 | (no activity feed on this page) | `activity_event`, last 10 days: only 6 × `sub_member.grant_queued` and 2 × `holder.release_slot_queued` (latest 10-02 20:28). 172 `member_access_log` rows in 7 days (4/2/7/7/14/14/31/9 per day). | The owner panel doesn't show recent activity at all; the activity feed is not surfaced here. |
| 12 | (not shown) | Production still has **only HOG**. No shell client has been created by the new Wix-install path yet. | Expected. The new-customer flow is untested in production until 918 Fitness is installed. |

Other: `webhook_log` still has an old row with `client_id = NULL` (2026-05-23), so the System Health query groups it separately and it never appears on a card. Harmless.

## Suggested follow-ups (not done; need your go-ahead)
1. **Surface exhausted jobs** (`QUEUE_JOB_EXHAUSTED` / `sources.status='failed'`) in the Errors check, or make sure they land in `error_queue`. This is the one that matters: a failing member grant currently looks clean.
2. **Identify the stuck grant** (Kisi 422, retried each reconcile) and fix or dismiss it — read-only lookup first.
3. Add an "Unattributed" card (or attribute `KISI_RESPONSE_ERROR`/`HARDWARE_VALIDATION_ERROR` to a client) so `client_id = NULL` errors are visible.
4. Exclude `deleted` from the member count (or show "64 members · 59 active · 9 removed").
5. Make the red rule "errors in last 24h" or "repeated across ≥2 runs", not "last 1h".
6. Show the recent `activity_event` feed on the owner panel, plus the reconcile Wix-vs-Kisi counts.

Review-only: no code in the app was changed for this report.

---

## SAGE ruling (BOT team review, 2026-10-03) and what was built

Primary team (NOVA, ORION, FAULT/REED, LENS/FORGE) and secondary team (SCOUT/QUINN, ATLAS/CIRCUIT, AXIOM/VERA, adversarial) reviewed this. All findings were checked against code or data before being ruled on.

**Root cause of "Errors: Clean".** A 4xx from Kisi ends the BullMQ job on its first attempt, but the dead-letter step (`core/queue-worker.js`) required all 3 attempts. Every refused grant was dropped: no error_queue row, no operator email. The stuck grant was a Couples-plan holder who released their seat (DR-051); reconcile step 3A ignored that and re-queued them every run (8 failed Kisi 422s since Sep 30). No member was locked out.

**Built on `claude/error-visibility-actions`** (not merged, not deployed):
1. 4xx failures now reach the error queue on the first attempt, with the original code/status kept (dedupe works).
2. Step 3A skips a paying holder who released their seat; a failed flag read still lets the grant flow.
3. `core/error-guidance.js`: every error states WHO must act (gym / AccessSync / nobody), whether Retry helps, and the next steps. Unknown errors always fall to AccessSync, so none is shown without an owner. A fresh Kisi 422 is the gym's to check (profile) then Retry; if it keeps failing it escalates to AccessSync.
4. Owner panel verdicts mean "someone must act": red only for open errors a person must fix or a stale reconcile; routine warnings never colour a card; reconcile is green under 13h (it runs every 12h); a new client shows a neutral "Setting up" (amber only after 48h stalled) instead of red; the Errors row says who must act, how old, and links to the list; errors with no client are attributed through trace_context or shown as "not tied to a client".
5. Owner-panel member count uses the dashboard's definition (active members, sub-members included).

**Ruled NOISE (not built):** metrics stack, trend charts, panel email/Slack alerts, activity feed on the owner panel, raw Wix-vs-Kisi counts (the dashboard already counts sub-members with members), retry caps, auto-emailing setup links.

**Later:** fill `client_id` on log rows at write time; downgrade lifecycle breadcrumbs from warn (overlaps OB-176); one live Kisi check of the 2 unexplained users plus a sub-member lapse test in dry_run.

**Heads-up when this deploys:** the operator email for a refused grant is sent to the client's `notification_email` (House of Gains: Daxx's address, not Chad's). The first real 4xx failure emails once per member and error code, and a nightly digest line appears while one stays open.
