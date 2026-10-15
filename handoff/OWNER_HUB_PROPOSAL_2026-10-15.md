# Owner hub — reduced proposal (SAGE, 2026-10-15)

Daxx's ask: "Expand on this idea, then reduce and simplify to the best options for an owner hub." His principle is that the
owner hub shows **real access problems for each customer's AccessSync service**, not member-by-member detail. Gym emails
go to the gym's own `notification_email`, which is set per gym; for House of Gains that address is currently Daxx's.

The team ran four parallel read-only reviews:
- LUMEN+REED: the owner's jobs.
- FAULT: every way a gym's service can break.
- MARGIN+SCOUT: subscription and business signals.
- LENS+FORGE: an audit of today's hub and emails in a browser, plus 3 layout concepts.

This file is SAGE's reduction of those four reviews.

## The one question the owner hub answers

> **"Is AccessSync working for every gym — and is there anything only I can fix?"**

Everything on the page either answers that question or is gone.

## Design: a problems inbox (layout A, with C's green chips)

1. **Verdict line, first thing on the page:** "All 3 gyms OK", or "1 of 3 gyms needs you · 1 waiting on the gym".
2. **Problem rows, only for gyms that aren't OK.** Each row shows the gym, what's broken, who acts (**You** / **The gym**), since when, and a button that opens that gym. Rows needing you sort first, then oldest first. A row uses one of a fixed set of reasons:

   | Reason | Who acts | Source |
   |---|---|---|
   | Door key rejected by Kisi, or not checked in 24h | The gym (key) / You (check not running) | `connector_subscriptions.key_last_error`, `key_last_verified` |
   | Sync failing (last run aborted, or no **successful** run in 13h / 26h) | You or the gym, depending on the abort reason | `reconciliation_run` status + abort_reason |
   | Purchases not arriving (silent vs this gym's own normal gap) | You / the gym | `clients.last_webhook_at`, `webhook_log` |
   | N members can't get in, AccessSync must fix | You | `error_queue` (guidance owner = accesssync) + members stuck > 24h (`pending_identity`, `recovery_pending`, failed sources) |
   | N members can't get in, gym must fix, **ignored > 48h** | The gym (you nudge) | `error_queue` (owner = gym), age |
   | Paying members parked with no door (location lapsed / door group gone) | You / the gym | new: raised as an error (bug 2 below) |
   | Setup incomplete / stalled: installed → key verified → plans mapped → first sale → first door | You (onboarding) | clients, connector_subscriptions, plan_mappings, webhook_log, member_access_log |

3. **Healthy gyms** collapse into small "✓ House of Gains" chips. Tapping one opens the gym's detail with today's checks.
4. **Platform row**, shown only when something is wrong: database, job queue / worker, background jobs that stopped (nightly sync, Kisi key check, day-pass sweep), and errors not tied to any gym.

The page grows with the number of problems, not the number of gyms, so it works at 1 gym and at 50.

**Removed from the owner hub:**
- the "Diagnostics" row (jargon, never red);
- held removals and other gym-decision alerts (now on the gym's Errors page);
- the "latest reconcile across all gyms" line (hides a single stale gym);
- the Wix administrators list and the clients management list (moved to a **Manage gyms** tab);
- the logged-in strip.

## Emails

| Email | To | When | Contents |
|---|---|---|---|
| **Owner daily** | AccessSync owner address | Every day, **including an all-clear** (silence must not be confused with a broken email) | Subject is the verdict. One line per gym problem (reason, who acts, since, link). Counts only, never member names. |
| **Owner immediate** | AccessSync owner address | Only when (a) access is blocked and only AccessSync can fix it, (b) a gym's door key fails, or (c) a platform outage | Grouped per gym, per type, per day |
| **Gym daily** (new) | That gym's `notification_email` | Only when something is open | Member-level lines: who didn't get access and why, removals waiting for their decision, missing door groups. Each has a link to their Errors page. |
| Gym "action needed" (exists) | That gym's `notification_email` | Per problem (already deduped + throttled) | Unchanged |

## Bugs to fix first (found by FAULT, confirmed in code; independent of the redesign)

1. **A failed sync reads green.** The panel uses `MAX(started_at)` whatever the status. Freshness must come from the last *successful* run, and an aborted latest run must show its reason.
2. **Paying members silently parked.** When a location has lapsed or its door group is gone, the resolver returns no mappings. The member is parked with an info log, with no error row and no alert, and `SUBSCRIPTION_LAPSED` is never raised. This must raise an error the gym or owner can see.
3. **A purchase lost if queuing fails.** The event is marked processed *before* it's queued, so if `eventQueue.add` throws, Wix's retry is dropped as a duplicate. The sync catches missed grants within about 6h, but revokes wait. Fix: un-mark on enqueue failure so the retry works.
4. **The Kisi key check never runs.** `core/hardware-health-check.js` expects a separate scheduled job that doesn't exist: `key_last_verified` is NULL and there are no results in 60 days. Run it from the app's own scheduler every 6h, like the sync.
5. **Stuck members are invisible.** Live examples: 1 member waiting 10 days in `pending_identity`, and 1 door assignment `failed` for 5 months. Count these in "members can't get in".
6. **Errors tied to no gym show amber under a green verdict.** Feed them into the verdict, or drop the row.

## Deferred, and why

- **Plan, monthly revenue, renewal.** The data is not trustworthy yet: `as_subscription_terms` and `as_client_subscriptions` are empty, and the prices conflict ($199 Pro in CLAUDE.md, $30/$60/$150 in DR-008, "Connect" on the live row). **Needs Daxx's pricing decision (P7).** Until then the hub shows nothing about billing rather than guess.
- **Value line per gym** ("265 members given access automatically, median 6s from purchase to door"). The data is good and it's strong renewal and sales material. It comes after the inbox, as a detail on the gym page.
- **Trends and churn signals** (member count falling, gym not logging in). These need history and an `operator.login` event. Phase 3.

## Build order

1. Bugs 1–6, with tests. Small changes, high value.
2. The owner hub problems inbox, plus the Manage gyms tab.
3. Emails: owner daily with all-clear, and gym daily to `notification_email`.
4. Later: the value line, pricing-backed billing view once P7 is decided, and trends.
