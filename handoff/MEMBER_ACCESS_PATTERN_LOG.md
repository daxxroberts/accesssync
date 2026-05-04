---
file: MEMBER_ACCESS_PATTERN_LOG.md
produced_by: LENS + KEEPER
date: 2026-05-03
purpose: Real-world access event patterns observed during HOG testing. Used to identify hardening opportunities.
---

# Member Access Pattern Log — HOG / Daxx Roberts

This log documents observed patterns from live testing against the House of Gains (HOG) production environment. Each pattern includes what happened, why it happened, and what hardening is needed.

**Test member:** Daxx Roberts (`2a6e78ae-c687-4001-b241-513a39ef8964`)
**Member identity ID:** `7af07f2c-6c9b-4180-9c79-6697e1d673a9`
**Kisi hardware_user_id:** `99561846`
**Current status:** `active` (provisioned 2026-05-03T16:28:05)

---

## DB Snapshot — 2026-05-03

### member_role_assignments (2 rows)
| mapping_id | role_assignment_id | hardware_group_id | created_at |
|---|---|---|---|
| `b72b1fd9` (Student plan) | `96686629` | `838622` | 2026-05-03 03:46 |
| `98dc0ffa` (Military plan) | `96686629` | `838622` | 2026-05-03 16:28 |

Both plans map to the **same Kisi group** (`838622`) and produce the **same role_assignment_id** (`96686629`). This means Daxx has two `member_role_assignments` rows but only one actual Kisi role. The multi-source safety logic (DR-034) is working correctly — the second grant detected the existing role and reused it rather than creating a duplicate.

### member_access_sources (2 rows)
| source_plan_id | mapping_id | granted_at |
|---|---|---|
| `2dcaf897` (Student) | `b72b1fd9` | 2026-05-03 03:46 |
| `87e831a4` (Military) | `98dc0ffa` | 2026-05-03 16:28 |

Two source rows, one per plan. This is correct — revoke of either plan alone will not remove Kisi access because the other source still exists. Only when both are revoked will the hardware role be removed.

---

## Patterns Observed

### Pattern 1 — Multi-plan same-group grant (correct behavior)
**What happened:** Daxx purchased two different plans (Student + Military) that both map to the same Kisi door group. The second grant correctly reused the existing Kisi role assignment instead of calling Kisi again.

**Why:** DR-034 pre-grant source check — `processGrant()` queries `member_access_sources JOIN member_role_assignments` before calling hardware. If a permanent role exists for this group, it skips the Kisi API call and reuses the `role_assignment_id`.

**Status:** Working correctly. No action needed.

---

### Pattern 2 — `wixSiteId: null` on all events
**What happened:** Every webhook payload shows `wixSiteId: null`. Tenant resolution falls back to `platformClientIdHint` (the clientId embedded in the webhook URL). This works for HOG but is fragile — if the URL-based hint is ever absent, tenant resolution fails entirely.

**Why:** The Wix `orderUpdated` and `orderStarted` event types do not include `siteId` in the payload body. AccessSync currently extracts site ID from the payload, not the request headers.

**Hardening needed:** Extract `x-wix-site-id` or equivalent from the HTTP request headers in `wix-connector.js` as the primary site ID source, falling back to payload extraction. Log a warning when both are null.

**OB to file:** OB-??? — `wixSiteId` extraction from request headers.

---

### Pattern 3 — `plan.started` fires with `(no client)` — orphaned traces
**What happened:** The `orderStarted` Wix event fires with no `platformClientIdHint` in the payload (unlike `orderUpdated` which includes it). Tenant resolution fails → trace shows `(no client)` → the event is dropped with no grant attempt.

**Why:** `plan.started` is a different Wix event type with a different payload structure. The `platformClientIdHint` extraction path doesn't cover it.

**Impact:** Low — `plan.purchased` (from `orderUpdated` with PAID status) fires at the same time and succeeds. The `plan.started` drop is harmless. But it creates noise in the trace log and would become a problem if `plan.purchased` ever fails.

**Hardening needed:** Either extract site ID from headers (fixes Pattern 2 and this), or explicitly document `plan.started` as intentionally un-routable and suppress the orphaned trace noise.

---

### Pattern 4 — Pre-trace-sprint provisioning events have no trace_id
**What happened:** All `member_access_log` rows before 2026-05-03 show `trace_id: null`, `mapping_id: null`, `hardware_group_id: null`. These are the 14+ provisioned/revoked events from April 23–24 during early HOG testing.

**Why:** The trace plumbing fix (Sprint 6 Phase 1, commit `d434b91`) wasn't deployed until late April. All events before that point lack trace context.

**Impact:** Historical events are permanently un-traceable. Not a bug — expected. The 332 historical rows noted in v4.15 CLAUDE.md.

**Status:** Accepted. No backfill warranted.

---

### Pattern 5 — Rapid repeated provisioning on 2026-04-24
**What happened:** 8 `provisioned` events fired between `01:01:00` and `19:53:18` on 2026-04-24, plus 3 `revoked` events. This suggests multiple plan purchases and cancellations in rapid succession during early testing.

**Why:** Early HOG testing — Daxx was purchasing and cancelling plans to test the provisioning pipeline. The multi-source logic wasn't live yet at that point.

**Hardening needed:** Verify that rapid grant→revoke→grant cycles don't leave orphaned Kisi roles. The `member_access_sources` table should be the guard — if a source row is deleted on revoke and a new one is added on re-grant, the count stays correct. Needs explicit test coverage.

**OB to file:** OB-??? — test rapid grant/revoke/re-grant cycle for source-count correctness.

---

### Pattern 6 — Today's test purchase trace incomplete (queue events missing)
**What happened:** Trace `2d8f2a30` (today's Military plan purchase) shows only 1 event — the webhook receipt. The queue worker grant events (role assignment write, Kisi API call, state update) are not attached to this trace.

**Why:** The queue worker picks up the job asynchronously. If the `trace_id` isn't threaded through from the webhook log to the queue worker job payload, the downstream events get a new or null trace context.

**Hardening needed:** Confirm `trace_id` is stored in the BullMQ job payload at enqueue time and restored into ALS context when the worker picks it up. This is a known Sprint 6 gap.

**OB to file:** OB-??? — thread trace_id through BullMQ job payload → queue worker ALS context.

---

## Summary — Hardening Priority

| Priority | Pattern | Action |
|---|---|---|
| High | Pattern 2 — `wixSiteId: null` | Extract from request headers in `wix-connector.js` |
| High | Pattern 6 — incomplete traces | Thread `trace_id` through BullMQ job payload |
| Medium | Pattern 3 — `plan.started` orphaned | Suppress noise or fix via header extraction |
| Medium | Pattern 5 — rapid cycle correctness | Add test coverage for grant/revoke/re-grant |
| Low | Pattern 4 — historical null traces | Accepted, no action |
| None | Pattern 1 — multi-plan same group | Working correctly |
