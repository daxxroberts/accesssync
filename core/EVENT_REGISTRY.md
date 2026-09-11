# EVENT_REGISTRY.md — AccessSync Log Event Taxonomy
**Governed by:** DR-038  
**Owner:** NOVA / KEEPER  
**Format:** `namespace.action[.qualifier]`

Every log event emitted by `log.*()` in production code is listed here.
New events require an entry before shipping. Events without entries are flagged by the no-raw-console P3 test.

**Persistence behavior:** see `core/EVENT_REGISTRY.json` for per-event overrides (OB-176, locked 2026-05-26). Default is level-based — `warn`/`error`/`critical` persist to `diagnostic_log`, `info`/`debug` do not. JSON entries flip individual events either direction.

---

## Namespaces

| Prefix | Service |
|---|---|
| `grant.*` | grant-revoke.js — provisioning grant path |
| `revoke.*` | grant-revoke.js — provisioning revoke path |
| `queue.*` | queue-worker.js — BullMQ job lifecycle |
| `adapter.*` | standard-adapter.js — L3 state and identity management |
| `hw.*` / `hardware.*` | hardware-adapter.js — hardware platform calls |
| `kisi.*` | kisi-connector.js — Kisi API calls |
| `wix.*` | wix-connector.js / wix-adapter.js / wix-plans-api.js |
| `hmac.*` | hmac-monitor.js — HMAC failure detection |
| `webhook.*` | webhook-processor.js — inbound webhook handling |
| `retry.*` | retry-engine.js — dead-letter and retry |
| `member.*` | member-sync-api.js — member access query |
| `reconcile.*` | reconciliation.js — drift detection and repair |
| `operator.*` | operator API routes |
| `admin.*` | admin server lifecycle |
| `logger.*` | logger internals (diagnostic_log write failures) |
| `activity.*` | activity.js middleware write failures |

---

## Grant / Revoke Events

| Event | Level | Description |
|---|---|---|
| `grant.role.source_exists` | info | OB-47: Member already has access from another source for this group — hardware call skipped, source row recorded |
| `grant.role.reused` | info | Idempotency guard hit: role assignment reused from prior grant (same mapping retry or shared group) |
| `grant.role.time_limit_not_applied` | warn | New plan is time-limited but group already has a permanent role assignment — time limit silently dropped |
| `grant.role.assigning` | info | Hardware assignRole call about to be made |
| `grant.group_not_found` | warn | Hardware group 404 — group flagged, member gets partial access. Since Phase 1 (2026-09-10) only after `getUserById` confirms the member's Kisi user still exists (see `grant.user_gone` / `grant.not_found_ambiguous`). |
| `grant.user_gone` | warn | Phase 1 (2026-09-10, I-6) — `assignRole` 404'd and `getUserById` returned null: the member's **Kisi user** is gone, not the door group. The group is NOT flagged (`plan_mapping_groups.health_status` untouched, no `group_not_found` alert). Fix round (F3): a **partial failure** of that one mapping, recorded as `HARDWARE_USER_GONE` (statusCode 404); no further `assignRole` is made on the same door-system account (each would 404 the same way — those mappings are recorded as `user_gone` without a call), but the loop continues, so a later mapping satisfied by the OB-47 reuse path is still collected. The job returns whatever was collected (HEAD's partial-success rule, `grant.partial_failure`) and throws `HARDWARE_USER_GONE` only when **nothing** was collected (statusCode 404 → dead-lettered, no retries). Context: `{ clientId, memberId, hardwareUserId, platformMemberId, mappingId, hardwareGroupId, collectedSoFar, stage, result }`. |
| `grant.not_found_ambiguous` | warn | Phase 1 (2026-09-10, I-6) — `assignRole` 404'd and the follow-up `getUserById` threw (`reason: 'user_lookup_failed'`, `lookupErrorCode`) or returned neither null nor an object (`reason: 'user_lookup_unexpected_result'`). Fail-safe: the group is NOT flagged — a door is never hidden from every member on an ambiguous 404. Fix round (F3): a **partial failure** of that one mapping (the original 404 is recorded); the loop continues and the other groups are still attempted, as at HEAD. The job throws the original 404 only when nothing at all was collected. Context adds `collectedSoFar`. |
| `grant.role.conflict_unresolved` | warn | Phase 1 fix round (2026-09-10, F4 / P-4) — `assignRole` threw `KISI_ROLE_CONFLICT_UNRESOLVED` (Kisi answered 409 "already assigned", but the adapter's recovery read found no matching user + group + `group_basic` assignment — see `kisi.role.conflict_unresolvable`). A **partial failure** of that one mapping: the group's health is NOT touched (the door is fine) and `getUserById` is not called; the loop continues. If every mapping fails, the job throws the first recorded failure — HEAD's all-failed path (statusCode 409 → 4xx → dead-lettered, not retried), no new status transition. Any other error, including a raw 409 without this code, still throws immediately. Context: `{ clientId, memberId, hardwareUserId, platformMemberId, mappingId, hardwareGroupId, collectedSoFar, stage, result }`. |
| `grant.partial_failure` | warn | Some groups succeeded, some failed — partial access granted. Since the Phase 1 fix round (2026-09-10) context adds `failureReasons` (one per failed group, ∈ `group_not_found`, `user_gone`, `not_found_ambiguous`, `role_conflict_unresolved`). |
| `grant.log.skipped_duplicate` | info | All role assignments reused — no member_access_log INSERT (Wix multi-fire dedup) |
| `revoke.start` | info | Revoke job started |
| `revoke.skipped.never_provisioned` | info | Cancel fired before grant completed — no hardware assignments to remove |
| `revoke.group.skipped` | info | Revoke for this group skipped — other active sources still hold access |
| `revoke.legacy_fallback` | warn | No member_role_assignments rows — falling back to legacy role_assignment_id from member_access_state |
| `revoke.unknown_event_type` | error | Unrecognised eventType on revoke path |
| `revoke.billing_cancelled` | info | **PERSISTED (DR-054).** DR-050: member_billing.status flipped to 'cancelled' on a genuine Wix plan/booking end. Money-state change — must be auditable. |
| `revoke.billing_status_preserved` | info | **PERSISTED (DR-054).** DR-050: billing deliberately left active because the revoke was a seat change (holder release / sub-member removal), not a real cancellation. Explains "why does billing still say active". |

---

## Queue Worker Events

| Event | Level | Description |
|---|---|---|
| `queue.job.start` | info | Job dequeued from BullMQ and processing started |
| `queue.job.complete` | info | Job completed successfully |
| `queue.grant.complete` | info | **PERSISTED via EVENT_REGISTRY.json override.** Final success line for a grant — fires after member_access status flip in_flight→active. Closes the trace timeline. |
| `queue.job.failed` | error | Job failed — includes lastStep and error details |
| `queue.job.missing_trace_id` | error | Job payload has no traceId — rejected before processing (enforcement gate) |
| `queue.grant.plan_unknown` | warn | No active plan mappings found for this planId |
| `queue.grant.no_api_key` | warn | No hardware API key configured for this client/location |
| `queue.grant.pending_start` | info | Grant parked as pending_start — plan has future start date |
| `queue.revoke.skip.no_identity` | info | Revoke skipped — member has no identity record |
| `queue.unknown_job_name` | warn | Job name not in known set (grant/revoke) |
| `queue.grant.parked.no_mapping` | info | **PERSISTED (DR-054).** Member paid but their plan isn't mapped to any hardware group — parked, **no access granted**. One of the two "paid but locked out" outcomes. |
| `queue.grant.parked.no_api_key` | info | **PERSISTED (DR-054).** Member paid but the client has no hardware API key saved — parked, **no access granted**. The other "paid but locked out" outcome. |
| `queue.grant.lock_acquired` | info | Suppressed (DR-054) — per-job breadcrumb: in_flight lock taken |
| `queue.grant.identity_resolved` | info | Suppressed (DR-054) — per-job breadcrumb: hardware user identity resolved |
| `queue.grant.mappings_resolved` | info | Suppressed (DR-054) — per-job breadcrumb: plan mappings looked up |
| `queue.grant.hardware_calls_complete` | info | Suppressed (DR-054) — per-job breadcrumb: all hardware calls finished, about to write state |

---

## Standard Adapter Events

| Event | Level | Description |
|---|---|---|
| `adapter.no_identity` | warn | Revoke path — no member_identity row found, skipping |
| `adapter.no_access_state` | warn | Revoke path — no member_access_state row found, skipping |
| `adapter.identity_cache_hit` | info | hardware_user_id resolved from DB cache |
| `adapter.identity_found` | info | Hardware findUserByEmail returned an existing user |
| `adapter.identity_creating` | info | No existing hardware user — createUser call about to start |
| `adapter.identity_replaced` | warn | Resolved hardware_user_id differs from cached value — stale rows purged |
| `adapter.identity.gate2_recovery_triggered` | warn | INVALID_HARDWARE_REQUEST: email missing — Gate 2 recovery ladder starting |
| `adapter.identity.gate2_recovered` | info | Email recovered successfully via Gate 2 |
| `adapter.identity.gate2_skipped` | warn | Gate 2 skipped — missing tenantId or platformMemberId |
| `adapter.identity.gate2_tier1_no_email` | warn | Wix Members API returned member record but no email |
| `adapter.identity.gate2_tier1_skipped` | warn | Tier 1 skipped — client missing source_api_key or source_site_id |
| `adapter.identity.gate2_tier1_failed` | error | Wix Members API call failed — proceeding to Tier 2 |
| `adapter.identity.gate2_tier2_failed` | error | DB cache email lookup failed |
| `adapter.identity.parked_pending_identity` | warn | Email unrecoverable — member parked as pending_identity |
| `adapter.identity.parked` | info | Member parked as pending_identity successfully |
| `adapter.identity.park_failed` | error | Failed to park member as pending_identity |
| `adapter.identity.gate2_cache_write_failed` | warn | Gate 2 email cache write to member_identity failed (non-fatal) |
| `adapter.activity_update_failed` | warn | client_activity_summary increment failed (non-fatal) |
| `adapter.first_grant_no_email` | info | First grant email skipped — no notification_email configured |
| `adapter.first_grant_email_sent` | info | First grant welcome email sent successfully |
| `adapter.first_grant_email_error` | error | First grant welcome email send failed |
| `adapter.pending_hardware_failed` | error | Failed to set pending_hardware status |
| `adapter.lock_release_failed` | error | Failed to release in_flight lock |
| `adapter.not_paying.record_failed` | warn | Phase 1 (2026-09-10) — `recordNotPayingObservation` (3B strike clock on `member_access_sources.not_paying_*`) failed with a DB error other than 42703. Returns `{ recorded:false }`, never throws; the proposal is recorded with no strike, so it can never become removal-eligible. Context: `{ accessId, sourcePlanId, errorCode }`. |
| `adapter.not_paying.clear_failed` | warn | Phase 1 — `clearNotPayingObservation` (member PAYING again → reset the strike clock) failed with a DB error other than 42703. Returns `{ cleared:false }`, never throws; the clock stays as it was and is retried next sweep. Context: `{ accessId, sourcePlanId, errorCode }`. |
| `adapter.not_paying.columns_missing` | warn | Phase 1 — the strike-clock columns do not exist yet (Postgres 42703: `migrations/reconcile-not-paying-strike.sql` not applied). ONE warn per process. No clock is recorded or cleared, so no member can become removal-eligible for not paying. Context: `{ op: 'record'\|'clear', migration }`. |

---

## HMAC Monitor Events

| Event | Level | Description |
|---|---|---|
| `hmac.failure` | warn | Single HMAC verification failure recorded |
| `hmac.failure_spike` | warn | Failure threshold crossed (3 in 5 min) — alert sent |
| `hmac.monitor.internal_error` | error | Redis or internal error in hmac monitor |
| `hmac.alert.no_email` | warn | Spike detected but no notification email configured |
| `hmac.alert.sent` | info | HMAC spike alert email sent |
| `hmac.alert.send_failed` | error | HMAC spike alert email failed to send |

---

## Webhook Processor Events

| Event | Level | Description |
|---|---|---|
| `webhook.received` | info | Inbound webhook received and parsed |
| `webhook.dedup.skipped` | info | Event already processed — idempotency check passed |
| `webhook.enqueued` | info | Event enqueued to BullMQ |
| `wix.member.resolved` | info | Suppressed (DR-054) — Wix Members API returned an identity during the resolve ladder. Per-lookup breadcrumb; the parked/recovered outcomes carry the signal. |
| `wix.parse.event_type_normalized` | info | Suppressed (DR-054) — Layer 2 mapped a raw Wix event name onto a standard eventType. Fires on every inbound webhook. Since Phase 1 (2026-09-10) `orderAutoRenewCanceled` normalizes to `plan.autorenew_cancelled`, which is in neither `core/event-routing.js` list: the processor logs `webhook.unrecognised_type` and enqueues nothing (the order stays ACTIVE and paid until `orderEnded`). |
| `wix.orders.no_member_id` | warn | Phase 1 (2026-09-10, I-2) — `listOrdersClassified` skipped Wix orders with no `buyer.memberId`/`buyer.contactId` (they cannot be tied to a member). ONE warn per call. Context: `{ siteId, count }`. |
| `wix.orders_classified.fetch_failed` | error | Phase 1 — `listOrdersClassified` threw: an HTTP error, or a `WIX_PAGE_INTEGRITY` error (page without an `orders` array, duplicate order id, >200 pages). Rethrown — the sweep aborts that client fail-closed (`reconciliation.wix_fetch_failed`, alert `wix_api_unavailable`). Never returns a partial list. Context: `{ siteId, httpStatus }`. |

---

## Retry Engine Events

| Event | Level | Description |
|---|---|---|
| `retry.dead_letter` | error | Job moved to error_queue after exhausting retries |
| `retry.operator.notified` | info | Operator notification email sent for dead-lettered job |
| `retry.operator.notify_failed` | error | Operator notification email failed to send |

---

## Member Sync API Events

| Event | Level | Description |
|---|---|---|
| `member.access_status.ok` | info | Member access status returned successfully |
| `member.access_status.no_identity` | info | Member has no identity record — returned empty access array |
| `member.access_status.jwt_invalid` | warn | JWT verification failed on member status request |

---

## Kisi Adapter Events (OB-152, OB-153)

| Event | Level | Description |
|---|---|---|
| `kisi.request` | debug | Outbound Kisi API request — every call logged with method + endpoint + retry attempt |
| `kisi.response.success` | debug | Successful 2xx response from Kisi |
| `kisi.response.error` | error / **warn** | Non-2xx response from Kisi — full structured context (status, Kisi body code/message, mapped error code) before throw. **Demoted to `warn` when the adapter layer is known to recover idempotently:** HTTP 409 on POST `/role_assignments` (assignRole) + HTTP 404 on DELETE `/role_assignments` (removeRole, OB-147). `recoverable: true` flag included on these warns. |
| `kisi.rate_limit.backoff` | warn | 429 response — sleeping before retry |
| `kisi.rate_limit.exhausted` | error | 429 retry budget exhausted (3 attempts) |
| `kisi.user.created` | info | New Kisi user created via createUser |
| `kisi.user.suspending` / `kisi.user.suspended` / `kisi.user.suspend_failed` | info / info / error | suspendAccess lifecycle (payment.failed flow) |
| `kisi.user.enabling` / `kisi.user.enabled` / `kisi.user.enable_failed` | info / info / error | enableAccess lifecycle (payment.recovered flow) |
| `kisi.user.deleting` / `kisi.user.deleted` / `kisi.user.delete_failed` | info / info / error | deleteUser lifecycle (member.deleted flow). Caller-side OB-125 source_tag guard required before invocation. |
| `kisi.user.delete_skipped_foreign` | warn | OB-125: deleteUser skipped because `member_identity.source_tag` is not `'accesssync'` — Kisi user identity may be shared with admin/staff or non-AccessSync grants and must not be deleted. AccessSync-side cleanup still proceeds (audit log + config_alert_log written). |
| `kisi.user.delete_skipped_already_gone` | info | **PERSISTED (DR-054).** Kisi user already absent at delete time — idempotent no-op. Explains a delete that appears to have done nothing. |
| `kisi.user.delete_guard_check` | info | Suppressed (DR-054) — per-call breadcrumb: DR-045 delete guard evaluating before a deleteUser |
| `kisi.role.assigning` / `kisi.role.assigned` / `kisi.role.assign_failed` | info / info / error | assignRole lifecycle (grant flow) |
| `kisi.role.already_exists` | info | 409 on assignRole — idempotent success, existing assignment fetched |
| `kisi.role.recovery_succeeded` | info | **PERSISTED via EVENT_REGISTRY.json override.** Pairs with `already_exists` — fires once the existing role assignment ID is in hand. Closes the recovery story in the trace timeline. |
| `kisi.role.conflict_unresolvable` | warn | 409 on assignRole but existing record could not be retrieved. Since Phase 1 (2026-09-10) recovery reads `GET /role_assignments?user_id=…` and matches group + `group_basic` role + user client-side; context adds `candidateCount` and `reason` ∈ `no_matching_assignment`, `recovery_read_not_found` (the recovery read itself 404'd). Fix round (P-4): throws `KISI_ROLE_CONFLICT_UNRESOLVED` (statusCode 409, original 409 on `cause`, never `HARDWARE_RESOURCE_NOT_FOUND`) instead of the raw 409 — `core/grant-revoke.js` records that group as a partial failure (`grant.role.conflict_unresolved`). Any other recovery-read failure (5xx, 429, 401/403, network) propagates unchanged. |
| `kisi.user.find_no_exact_match` | warn | Phase 1 (2026-09-10, I-4) — `findUserByEmail` got results back but none whose email matches exactly (trimmed, case-insensitive). Returns null instead of blindly reusing `data[0]`, so the grant path creates/resolves the right user rather than attaching access to a lookalike account. Count only — no emails logged (DR-001). Context: `{ resultCount }`. |
| `kisi.page_integrity_failed` | warn | Phase 1 (I-4) — a Kisi bulk list (`listAllUsers`, `getManagedRoleAssignments`) returned a page that is not an array, repeated an id across pages, or exceeded the 100-page cap. Throws `KISI_PAGE_INTEGRITY` (`integrityReason` ∈ `non_array_page`, `duplicate_id`, `page_cap_exceeded`) — never returns a partial list. The sweep aborts the client (assignments) or skips Pass 3 (users). Fix round (F7): also `getRoleAssignmentsForUser` on a 2xx whose body is not an array (`non_array_page`, context adds `userId`, `bodyType`) — it used to be read as `[]` ("no other door"). Both callers fail closed: finalizeRevoke Guard D refuses the delete (`adapter.finalize_revoke.assignment_check_failed`) and DR-045 Layer C in `deleteUser` aborts before its DELETE. `[]` is returned only for an HTTP 404. Context: `{ endpoint, reason, … }`. |
| `kisi.role.removing` / `kisi.role.removed` / `kisi.role.remove_failed` | info / info / error | removeRole lifecycle (revoke flow) |
| `kisi.role.remove_skipped_already_gone` | info | OB-147: 404 on removeRole — role already gone, treated as idempotent success |
| `kisi.managed_assignments.fetched` / `kisi.managed_assignments.fetch_failed` | info / error | getManagedRoleAssignments — reconciliation Kisi-side data fetch. Since Phase 1 (2026-09-10) a failure **throws** (it used to return `[]`, which read as "nobody has a door"); the sweep aborts that client (`reconciliation.kisi_fetch_failed`). |
| `kisi.get_groups_no_key` / `kisi.get_groups_failed` | warn / error | getGroups — onboarding + plan-mapping dropdown fetch |
| `kisi.get_role_assignments_no_key` | warn | Reconciliation called without API key |
| `kisi.get_locks_no_key` / `kisi.get_locks_failed` | warn / error | getLocks — reconciliation door-lockdown sync |

Required context fields per event vary; minimum for adapter calls: identifying ID(s) (`userId`, `groupId`, `roleAssignmentId`), `statusCode` on errors. ALS auto-populates `trace_id`, `actor_type`, `actor_id`. No PII in Kisi event payloads — emails/names from member_identity are not included.

---

## Sub-Member Lifecycle Events (DR-044)

| Event | Level | Description |
|---|---|---|
| `member.sub_member.soft_deleted` | info | DR-044: Sub-member finalize succeeded — `sub_member_status='deleted'`, PII NULL'd. Atomic UPDATE matched expected `'removing'` prior state. Lands in `member_access_log` as `event_type='sub_member_soft_deleted'`. |
| `member.sub_member.soft_delete_idempotent_skip` | warn | DR-044: Finalize UPDATE matched 0 rows on a sub-member (plan_holder_id not NULL). Race or replay — already in terminal `'deleted'` state or never reached `'removing'`. Diagnostic only; not an error. |
| `adapter.finalize_revoke.delete_kisi_user_start` | info | OB-248: DR-044 finalize started for a member whose access just rolled up to `'inactive'`. About to call `hardwareAdapter.deleteUser`. |
| `adapter.finalize_revoke.complete` | info | **PERSISTED via EVENT_REGISTRY.json override.** OB-248: DR-044 finalize succeeded — Kisi user deleted (or was already gone), `member_access.status='deleted'`, all PII NULL'd on `member_master`. Trace-closing line for the revoke chain. |
| `adapter.finalize_revoke.already_deleted` | info | OB-248: idempotent — access was already at `status='deleted'`. No-op. |
| `adapter.finalize_revoke.access_still_active` | info | OB-248: skipped — `member_access.status` was not `'inactive'` (other sources still active for this person). No PII purge, no Kisi delete. |
| `adapter.finalize_revoke.access_missing` | warn | OB-248: skipped — `member_access` row no longer exists for the (memberId, tenantId) pair. Should never fire under normal operation. |
| `adapter.finalize_revoke.no_hardware_user` | info | OB-248: member never had a Kisi user (`hardware_user_id` NULL). DB-side finalize still runs (status→`deleted`, PII NULL). |
| `adapter.finalize_revoke.refused_unowned` | warn | OB-248: DR-045 Layer B refused — Kisi user has no AccessSync marker. Operator-side or pre-DR-045 user. PII NOT purged; access stays `'inactive'`. Surfaces to `config_alert_log` as `finalize_revoke_refused_unowned_user`. |
| `adapter.finalize_revoke.refused_cross_tenant` | warn | OB-248: DR-045 Layer B refused — marker exists but names a different client_id. Multi-tenant cross-talk attempt or stale marker. PII NOT purged. Surfaces to `config_alert_log` as `finalize_revoke_refused_client_mismatch`. |
| `adapter.finalize_revoke.refused_elevated` | warn | OB-248: DR-045 Layer C refused — user holds an elevated role (admin/manager/owner/place scope). Operator must demote first. PII NOT purged; access stays `'inactive'`. Surfaces to `config_alert_log` as `finalize_revoke_refused_elevated_role`. |
| `adapter.finalize_revoke.refused_foreign_source_tag` | warn | OB-248: Defense-in-depth Layer A — `member_master.source_tag` is not `'accesssync'`. Same disposition as `refused_unowned`. |
| `adapter.finalize_revoke.refused_shared_user` | warn | Phase 1 Guard E (2026-09-10, I-5) — another live `member_access` row (different id, status not `'deleted'`) points at the same `hardware_user_id`. Deleting the Kisi user would take that other person's access with it, so: no Kisi delete, PII NOT purged, access stays `'inactive'`. Returns `{ finalized:false, reason:'shared_hardware_user' }` (queue-worker logs it as a skipped finalize, no throw). Surfaces to `config_alert_log` as `finalize_refused_shared_user`. Context: `{ memberId, tenantId, hardwareUserId, otherAccessCount, otherAccessIds }`. |
| `adapter.finalize_revoke.refused_other_assignments` | warn | Phase 1 Guard D (I-5) — after the revoke, the Kisi user still holds ≥1 role assignment (door access AccessSync did not add). No Kisi delete, PII NOT purged, access stays `'inactive'`. Returns `{ finalized:false, reason:'user_has_other_assignments' }`. Surfaces to `config_alert_log` as `finalize_refused_other_assignments`. Context: `{ memberId, tenantId, hardwareUserId, assignmentCount }`. |
| `adapter.finalize_revoke.assignment_check_failed` | warn | Phase 1 Guard D (I-5) — the `getRoleAssignmentsForUser` lookup threw, returned a non-array, or the method is missing. Fail-closed: same disposition as `refused_other_assignments` (no delete, no purge, access stays `'inactive'`), reason `'assignment_check_failed'`, no alert row. Context: `{ memberId, tenantId, hardwareUserId, statusCode, errorMessage }`. |
| `adapter.finalize_revoke.kisi_delete_failed` | error | OB-248: Kisi `deleteUser` threw an error other than the 3 guard refusals (network, 5xx, transient). Bubbles up to queue-worker → BullMQ retries the whole revoke job (idempotent — `completeRevoke` already committed). |
| `adapter.finalize_revoke.db_finalize_failed` | error | OB-248: Kisi delete succeeded but the DB UPDATE transaction (set `'deleted'` + NULL PII) failed. Rolled back. Bubbles up so the retry can re-attempt — Kisi delete itself is idempotent. |

Required context fields: `clientId`, `memberId`, `platformMemberId`, `stage='revoke'`, `result`. ALS auto-populates `trace_id`, `actor_type`, `actor_id`. No PII fields included (PII is NULL by the time these events fire, and was never in the event payload).

`member.sub_member.revoke_failed` is intentionally NOT a discrete event — revoke failures are captured by the existing failure pipeline (`error_queue` row + `diagnostic_log` rows from `retry-engine.js`). Sub-member soft-delete inherits this.

---

## Reconciliation Events

| Event | Level | Description |
|---|---|---|
| `reconcile.member.start` | info | Per-member reconcile started |
| `reconcile.member.complete` | info | Per-member reconcile complete — summary returned |
| `reconcile.member.no_identity` | info | No identity record — reconcile skipped |
| `reconcile.integrity.alert` | warn | Integrity issue detected — alert written to config_alert_log |
| `reconciliation.stale_reset` | warn | Stale `in_flight` member_access lock (>10 min) reset to `status='recovery_pending'`. Next reconcile sweep picks it up via `_fetchActionableRecords` and re-attempts the grant. Context: `{ stage, result, newStatus: 'recovery_pending' }`. (OB-202) |
| `reconciliation.sweep_start` | info | Suppressed (DR-054) — nightly sweep began. One per run; the per-client outcome events carry the useful signal. |
| `reconciliation.requeued` | info | Suppressed (DR-054) — sweep re-queued a member for reprocessing. Can fire in volume during a large sweep. Promote if a real diagnosis ever needs it. |
| `source_retry.run_start` | info | OB-240 source-retry-probe cron started — picking up `pending_hardware`/`pending_start` source rows for re-grant |
| `source_retry.run_complete` | info | OB-240 source-retry-probe cron complete — summary counts (candidates/succeeded/failed/exhausted/skipped) |
| `source_retry.candidate_found` | info | OB-240 probe selected a source row for retry — one log per candidate row, includes sourceId/clientId/accessId/hardwareGroupId/retryCount |
| `source_retry.success` | info | **PERSISTED via EVENT_REGISTRY.json override.** OB-240 probe succeeded — source row flipped `pending_*`→`active`, parent `member_access` status rollup recomputed |
| `source_retry.failed` | warn | OB-240 probe attempt failed (single attempt; retries remain). `retry_count` bumped, `failure_reason` written. `recoverable: true` flag set. |
| `source_retry.exhausted` | error | OB-240 probe attempt exhausted retries (`retry_count` reached 3). Source row flipped to `failed`; `error_queue` row INSERTed with `error_code='SOURCE_RETRY_EXHAUSTED'`. Operator-visible. |
| `source_retry.skipped_no_kisi_user` | warn | OB-240 probe skipped a source row because `member_master.hardware_user_id` is NULL — member never got a Kisi user. Different recovery path (identity resolution, not source retry). |
| `source_retry.row_unhandled_error` | error | OB-240 probe caught an unhandled error in the per-row retry block (defense-in-depth — should not normally fire). |
| `source_retry.fatal` | critical | OB-240 probe top-level crash — Railway Cron will surface non-zero exit. |
| `reconciliation.sub_member_holder_lapsed` | info | **PERSISTED via EVENT_REGISTRY.json override.** OB-247 Pass 1.5 — a sub-member's holder is no longer paying for the sub's plan. A synthetic `plan.cancelled` revoke has been queued for ONE of the sub-member's active source rows (one event per source). Context: `{ subAccessId, platformMemberId, sourcePlanId, jobId, traceId, sweepTraceId }`. **Not emitted in Phase 1 (2026-09-10):** the sweep is observation-only — holder lapses are recorded as proposals and held (`reconciliation.revokes_held`, alert `revoke_holder_lapse_pending`); this event returns when Phase 3b arms removal. |
| `reconciliation.sub_member_holder_lapsed_queue_failed` | error | OB-247 Pass 1.5 — failed to enqueue the synthetic revoke job for a specific sub-member source. Other source revokes in the same sweep are unaffected. Investigate BullMQ/Redis health. Unreachable in Phase 1 (2026-09-10) — the sweep enqueues no revokes. |
| `reconciliation.pass_1_5_complete` | info | OB-247 Pass 1.5 finished for a client. Reports `lapsedSubsFound` (count of sub-members whose holder is non-active) and `subMemberRevokesQueued` — since Phase 1 (2026-09-10) this counts revokes **proposed** across all source plans (field name kept for continuity); Phase 1 records and holds every one of them and enqueues none (`reconciliation.revokes_held`). Also reports `subsExamined`. The lapse test is Wix-based: the holder must have a PAYING plan with the sub's `source_plan_id` in either Wix read. Fix round (2026-09-10, F2): a lapse is proposed only when the **holder's** classification for that plan (best across both reads) is `ENDED` or `ABSENT`; a holder whose payment is `DECLINED` / `PENDING` / `UNKNOWN` — or who cannot be found — leaves the sub alone as `held_payment_state`, counted in the new `subsHeldPaymentState`. |
| `reconciliation.pass_1_5_failed` | error | OB-247 Pass 1.5 top-level error — query failed or unhandled exception. Sweep continues to Pass 2/3 for this client. |
| `reconciliation.pass_3_aborted_kisi_unavailable` | warn | OB-249 Pass 3 — `listAllUsers` threw. Outage short-circuit: Pass 3 aborts for this client; Pass 1, Pass 1.5, and the grant queue continue. Re-attempted next sweep. |
| `reconciliation.pass_3_skipped_unsupported_platform` | info | OB-249 Pass 3 — `hardware_platform !== 'kisi'` (Seam stub doesn't implement `listAllUsers`). Skipped, no action. |
| `reconciliation.kisi_user_disappeared_first_sighting` | info | OB-249 Pass 3 — bulk Kisi user-list missing this member's `hardware_user_id` for the FIRST sweep. Two-strike marker `kisi_user_disappeared_observed_at` set. No destructive action. |
| `reconciliation.kisi_user_disappeared_confirmed` | warn | **OB-249 Pass 3 — SECOND consecutive sweep with the member's Kisi user missing. Synthetic plan.cancelled queued per active source. Operator manually deleted the user in Kisi dashboard (or persistent Kisi failure).** **Not emitted in Phase 1 (2026-09-10):** the finding is recorded instead — `repair_pending` if the member is PAYING for that plan (alert `sweep_repair_pending`), else a held removal proposal. |
| `reconciliation.kisi_user_recovered` | info | OB-249 Pass 3 — the user that was previously marked missing is back in Kisi. Two-strike marker cleared (`kisi_user_disappeared_observed_at = NULL`). Transient outage or operator restored the user. |
| `reconciliation.role_assignment_drifted` | warn | **OB-249 Pass 3 — user exists in Kisi but one of our DB-active source rows is missing its expected `(user_id, group_id)` role assignment.** Operator removed a specific role via Kisi dashboard. Per-source synthetic plan.cancelled queued. A12 universe filter applied (only groups AccessSync manages). **Not emitted in Phase 1 (2026-09-10):** same routing as `kisi_user_disappeared_confirmed` — PAYING → `repair_pending`, otherwise a held removal proposal. |
| `reconciliation.pass_3_revoke_queue_failed` | error | OB-249 Pass 3 — BullMQ enqueue failed for a specific drift-derived revoke. Other Pass 3 revokes in same sweep unaffected. Investigate Redis health. Unreachable in Phase 1 (2026-09-10) — the sweep enqueues no revokes. |
| `reconciliation.pass_3_complete` | info | OB-249 Pass 3 finished for a client. Reports: `outage`, `totalKisiUsersFetched`, `disappearedFirstSighting`, `disappearedConfirmed`, `roleDrifted`, `userRecovered`, `repairPending`. Since Phase 1 (2026-09-10) `disappearedConfirmed` and `roleDrifted` count **detections**, not enqueues; `repairPending` is how many of them belong to a member PAYING for that plan (a missing door → `repair_pending`, never a removal). |
| `reconciliation.revokes_held` | warn | Phase 1 (2026-09-10) — the sweep's single removal decision (`core/revoke-policy.js` `evaluateRemovals`) held this client's proposed removals. ONE event per client per sweep, whenever anything was proposed. Context: `{ clientId, reason, detail, dataSource, mode, observationOnly, heldCount, heldMembers, heldUnits, bySource, byDataSource, strikeReady, strikeClocksFrozen, sampleMemberKeys (≤10 platform member ids), traceId }`. `reason` ∈ `invalid_proposal`, `snapshot_unstable`, `mass_revoke` (anomalies — judged first even while paused: run `aborted` + ONE de-duplicated `config_alert_log` row `revoke_invalid_proposal` / `wix_snapshot_anomaly` / `revoke_batch_mass_revoke`), `observation_only` (Phase 1: removal is not armed, whatever the mode), and — once 3b arms it — `auto_revoke_off`, `dry_run`, `strike_pending`. `heldUnits` is what every cap counts (fix round P-1: a family — holder plus subs — is one unit). `strikeClocksFrozen` is true on an anomaly hold: that sweep neither advanced nor cleared any not-paying clock (fix round F5). `strikeReady` previews how many would clear the not-paying strike. Held removals are not lost — the next sweep re-derives any that are still true. **Nobody loses access in Phase 1.** |
| `reconciliation.payment_state_held` | warn | Phase 1 fix round (2026-09-10, F2) — members PAYING in neither Wix read whose best classification for that plan (for a sub-member: the holder's) is `DECLINED`, `PENDING` or `UNKNOWN`. A declined, pending or unrecognized payment is not a cancellation: each (member, plan) is recorded as a `reconciliation_proposal` row of kind `held_payment_state` (`hold_reason = 'payment_state_not_removable'`, no strike, no policy decision), is **never** proposed for removal, is left out of every removal population, and has any running not-paying clock cleared (skipped on an anomaly-held sweep). One de-duplicated `revoke_held_payment_state` alert per unit; no `sweep_removal_pending`. Suspension is Phase 4's job. ONE event per client per sweep. Context: `{ clientId, heldCount, heldUnits, bySource, byClassification, clocksCleared, strikeClocksFrozen, sampleUnitKeys (≤10), traceId }`. **Nobody loses access.** |
| `reconciliation.holder_seated_read_failed` | warn | Phase 1 fix round (2026-09-10, F12) — Pass 1 reads `member_billing.holder_seated` for a (member, plan) BEFORE its `cancelled → active` promotion, so a seat the holder released (DR-051, `holder_seated = false`) is never resurrected; the same value feeds the DR-051 seat self-heal (one read per (member, plan)). That read threw: the whole plan is skipped for this member this sweep — no promotion, no insert, no heal — and is left exactly as found. Context: `{ clientId, platformMemberId, planId, traceId }`. |
| `reconcileMember.hardware_fetch_failed` | warn | Phase 1 fix round (2026-09-10, F15) — the per-member re-check's `getManagedRoleAssignments` threw (HTTP error, `KISI_PAGE_INTEGRITY`) or returned a non-array. Nothing is queued or written: `reconcileMember` returns `action: 'hardware_unavailable'` with alert code `hardware_api_unavailable` and the plain-English detail "AccessSync couldn't reach the door system — no changes were made." Context: `{ clientId, memberId, hardwarePlatform, statusCode, code, traceId }`. |
| `reconciliation.revoke_held` | warn | A single automatic removal outside the sweep batch was skipped because `clients.auto_revoke_mode` is not `'on'` (`'off'`, `'dry_run'` — the migration default — or unreadable). Context: `{ path, reason, clientId, ... }`, `reason` ∈ `auto_revoke_off`, `dry_run`. `path` ∈ `holder_seat_release` (DR-051 seat self-heal skipped — the released seat is still not re-added; adds `platformMemberId`, `sourcePlanId`), `reconcile_member` (per-member re-check found no active plan but live door access and left it in place; adds `memberId`, `platformMemberId` — unreachable as written, at HEAD `c89b7c0` too: `reconcileMember` step 7a returns `needs_attention` first whenever 7b's condition holds; the gate stays so 7b can never fire unarmed). (The v2 `requeue` path is gone: error_queue revoke replays are now `reconciliation.requeue_skipped_revoke`.) |
| `reconciliation.revoke_queue_failed` | error | BullMQ enqueue failed for an approved Wix-absence (3B) removal in `_enqueueApprovedRevoke`. Per-item. Kisi-drift and holder-lapse failures keep their own events (`pass_3_revoke_queue_failed`, `sub_member_holder_lapsed_queue_failed`). Context: `{ clientId, platformMemberId, jobId, source, traceId }`. **Unreachable in Phase 1** — nothing calls `_enqueueApprovedRevoke`, and it refuses while observation-only (`reconciliation.revoke_enqueue_refused_observation_only`). |
| `reconciliation.requeue_skipped_unroutable` | warn | `_processRecordTargeted` found an error_queue event type that is neither a grant nor a revoke (`core/event-routing.js` → null). Skipped — never defaulted to a revoke (the pre-2026-09-10 code replayed `plan.started` as a revoke). Context: `{ memberId, platformMemberId, eventType }`. |
| `reconciliation.requeue_skipped_revoke` | warn | Phase 1 (2026-09-10) — error_queue replay is **grant-only**. The row's event type, or its payload's own `eventType`, routes to a revoke (a grant-labelled row carrying a revoke payload is replayed as neither). Skipped; the member keeps whatever access they have. Context: `{ memberId, platformMemberId, clientId, eventType, payloadEventType }`. |
| `reconciliation.requeue_skipped_not_paying` | warn | Phase 1 — a failed grant was not replayed because the member is not PAYING in this sweep's Wix read. `reason` ∈ `no_wix_read` (this client's Wix double read failed or did not run), `member_not_paying`, `plan_not_paying` (the event names a plan the member isn't paying for). Context: `{ memberId, platformMemberId, clientId, eventType, planId, reason }`. |
| `reconciliation.requeue_skipped_unreadable_payload` | warn | Phase 1 — the error_queue payload parsed to null, a primitive or an array: nothing to replay. Skipped. Context: `{ memberId, platformMemberId, eventType }`. |
| `reconciliation.requeue_record_failed` | warn | Phase 1 — one error_queue replay threw; caught per record so the rest of step 4, the digest and `last_sync_at` still run. Context: `{ memberId, clientId }`. |
| `reconciliation.kill_switch_read_failed` | error | Reading `clients.auto_revoke_mode` threw (e.g. `migrations/reconcile-auto-revoke-kill-switch.sql` not applied yet). Fail-closed to `'off'`: the DR-051 self-heal and `reconcileMember`'s per-member removal hold for that client; grants and the `reconciliation_run` audit row are unaffected. Context: `{ clientId }`. (Event name kept from the v2 boolean kill switch.) |
| `reconciliation.client_sync_skipped_locked` | warn | Phase 1 (2026-09-10) — `pg_try_advisory_lock(hashtext('reconcile:' \|\| clientId))` returned false: another sweep of this client is running (boot sweep, Railway cron, in-process scheduler and manual `/sync/run` can overlap). No run row opened, nothing changed; returns `skipped: 'locked'`. Context: `{ clientId, triggeredBy, traceId }`. |
| `reconciliation.client_lock_unavailable` | warn | Phase 1 — the advisory-lock **mechanism** failed (`db.getClient` missing/throwing, the lock query throwing or answering nonsense), as opposed to the lock being held. The sync PROCEEDS without the lock — harmless while the sweep enqueues no removals, and skipping would also skip grants. Phase 3b must fail closed here. Context: `{ clientId, errorCode, traceId }`. |
| `reconciliation.client_lock_release_failed` | warn | Phase 1 — `pg_advisory_unlock` threw (`reason: 'unlock_threw'`) or reported nothing held (`reason: 'not_held'`). The dedicated connection is destroyed instead of pooled, which ends the session and frees any lock. Context: `{ clientId, reason, errorCode }`. |
| `reconciliation.wix_reads_disagreed` | warn | Phase 1 — the two Wix reads (`_doubleReadDelayMs` apart) disagreed on who is PAYING for at least one member. PAYING in **either** read counts as paying, so a flapping member is never proposed for removal on one bad read. Large disagreement also makes the removal decision hold with `snapshot_unstable`. Context: `{ clientId, readDisagreement: { wix_orders, wix_bookings }, payingRead1, payingRead2, traceId }`. |
| `reconciliation.kisi_fetch_failed` | warn | Phase 1 — `getManagedRoleAssignments` threw (HTTP error or `KISI_PAGE_INTEGRITY`) or returned a non-array. Aborts the client's sync exactly like a Wix failure: no grants, no proposals, run row `aborted` (`abort_reason = 'hardware_api_unavailable'`), `config_alert_log` row `kisi_api_unavailable` (`hardware_api_unavailable` on a non-Kisi platform). Context: `{ clientId, hardwarePlatform, statusCode, code, traceId }`. |
| `reconciliation.active_source_census_failed` | warn | Phase 1 — the query listing active provisioned members and their source plans (3B + strike clocks + populations) threw. 3B proposes nothing and no strike clock is touched for that client this sweep. Context: `{ clientId, traceId }`. |
| `reconciliation.strike_clock_unavailable` | warn | Phase 1 — the not-paying strike columns do not exist yet (42703: `migrations/reconcile-not-paying-strike.sql` not applied). ONE warn per process. No clock is read, started or cleared, so nothing can become removal-eligible. Context: `{ clientId, migration }`. |
| `reconciliation.strike_read_failed` | warn | Phase 1 — reading the existing strike clocks failed with a non-42703 error. Every proposal carries no strike this sweep (never removal-eligible on it). After a non-anomaly decision the observations are still recorded (`COALESCE` keeps an existing clock's start, so this only ever makes a member look newer — never older); clocks of members PAYING again are not cleared this sweep; `held_payment_state` clocks are still cleared. Context: `{ clientId, errorCode }`. |
| `reconciliation.strike_clear_failed` | warn | Phase 1 — `standardAdapter.clearNotPayingObservation` threw for a (member, plan) PAYING again, or (fix round F2) for a `held_payment_state` (member, plan). The clock stays; retried next sweep. Context: `{ clientId, accessId, sourcePlanId }`. |
| `reconciliation.strike_record_failed` | warn | Phase 1 — `standardAdapter.recordNotPayingObservation` threw for a WIX_ABSENCE proposal (a primary PAYING in neither read, classified `ENDED` / `ABSENT`). Fix round (F5): observations are recorded only AFTER `evaluateRemovals`, and only when its decision is not an anomaly hold. The clock does not advance this sweep. Context: `{ clientId, accessId, sourcePlanId }`. |
| `reconciliation.proposal_population_mismatch` | warn | Phase 1 — some removal proposals' units (fix round P-1: `unitKey`, the holder for a sub-member) are not in their data source's population set or in the union. Should never fire (a caller bug in the population arithmetic). Diagnostic only — `evaluateRemovals` compares unit counts, so it holds the batch as `invalid_proposal` only if the proposals then outnumber a population; Phase 1 holds the batch either way. Context: `{ clientId, count, bySource, traceId }`. |
| `reconciliation.flush_ignored_observation_only` | warn | Phase 1 tripwire — `evaluateRemovals` returned a non-empty `flush` despite `observationOnly: true`. Ignored: Phase 1 has no flush loop, nothing is enqueued. Should never fire. Context: `{ clientId, flushCount, traceId }`. |
| `reconciliation.revoke_enqueue_refused_observation_only` | warn | Phase 1 tripwire — `_enqueueApprovedRevoke` (kept for Phase 3b) was called while `SWEEP_OBSERVATION_ONLY` is true and refused. Nothing calls it in Phase 1; should never fire. Context: `{ clientId, source, platformMemberId, sourcePlanId, traceId }`. |
| `reconciliation.repairs_pending` | warn | Phase 1 — Pass 3 found PAYING members whose expected Kisi user or role assignment is missing (a missing door). Recorded as `repair_pending` (never a removal) with one de-duplicated `sweep_repair_pending` alert per member; not repaired automatically yet. ONE event per client per sweep. Context: `{ clientId, repairCount, repairMembers, bySource, sampleMemberKeys, traceId }`. |
| `reconciliation.alert_write_failed` | warn | Phase 1 — the de-duplicated `config_alert_log` INSERT (`_insertAlertOnce`) threw. Never blocks the sweep. Context: `{ clientId, alertType }`. |
| `reconciliation.proposal_log_unavailable` | warn | Phase 1 — `reconciliation_proposal` does not exist yet (42P01: `migrations/reconcile-proposal-log.sql` not applied). ONE warn per process; the sweep carries on. Context: `{ clientId, migration }`. |
| `reconciliation.proposal_log_failed` | warn | Phase 1 — a batched `reconciliation_proposal` INSERT failed with another error. That chunk is not recorded; the sweep carries on. Log only — nothing reads the table to decide. Context: `{ clientId, runId, count, errorCode }`. |
| `kisi.list_users.fetched` | info | OB-249 — Kisi `listAllUsers` paginated through all users in the org. `totalUsers` count included. |
| `kisi.list_users_no_key` | warn | OB-249 — `listAllUsers` called without an API key. Returns empty array, no throw. |
| `kisi.list_users_failed` | error | OB-249 — Kisi bulk user-list paginate threw at some offset. Caller (Pass 3) catches and treats as outage. |

### Reconciliation Phase 1 — observation-only sweep (2026-09-10)

**The sweep removes no one.** Every removal path in `_syncClient` — 3B Wix absence (PAYING in
neither Wix read), Pass 3 Kisi-user-gone and role drift for non-paying members, Pass 1.5
holder lapse — pushes a *proposal*. One decision (`core/revoke-policy.js` v3
`evaluateRemovals`, called with `observationOnly: true`) holds them all, whatever
`clients.auto_revoke_mode` says, and there is no flush loop: `revoked` is always 0. Anomalies
are still judged first (validate → instability → mass cap), so a paused client still learns
its data looks wrong. Pass 3 findings for PAYING members are `repair_pending` (a missing
door), never a removal. Grants still run, but only for PAYING plans (an ACTIVE + UNPAID
order is never granted by the sweep).

Wix is read twice, `_doubleReadDelayMs` apart; PAYING in **either** read counts. Either Wix
read or the Kisi assignment read failing aborts the client (no grants, no proposals).

**Fix round (2026-09-10)** — what the sweep may propose, and how it is counted:

- **Only a cancellation is a removal candidate (F2 / P-2).** 3B and Pass 1.5 propose a
  (member, plan) only when its best classification across both reads (for a sub-member, the
  holder's) is `ENDED` or `ABSENT`, and pass it on the proposal as `classification`.
  `DECLINED`, `PENDING` and `UNKNOWN` become `held_payment_state` records instead: no strike,
  never proposed, not counted in any removal population, any running not-paying clock cleared,
  one `revoke_held_payment_state` alert per unit (`reconciliation.payment_state_held`).
- **Decision units (P-1).** Every proposal carries `unitKey` — the member for `WIX_ABSENCE`,
  the holder for `HOLDER_LAPSE`, the holder (sub-members) or the member for Kisi sources. The
  policy counts distinct units for its caps and checks, and every population is a count of
  units: `wix_orders` = primaries with an active plan source plus the holders of active subs;
  `wix_bookings` = booking members; `kisi` = the units of Pass 3's rows; `currentManaged` = the
  union. A family is one unit.
- **Strike clocks move only after the decision (F5).** Proposals carry each clock as the DB
  had it; `evaluateRemovals` runs first; only when its reason is not an anomaly hold are
  observations recorded and clocks cleared. **An anomaly-held sweep neither advances nor clears
  any clock** (`strikeClocksFrozen: true`) — Phase 3b depends on this.
- **Per-member alerts on a mass hold (F9).** `sweep_removal_pending`,
  `revoke_holder_lapse_pending` and `revoke_held_payment_state` are kept when the batch is held
  for `mass_revoke` (a volume problem — each member's evidence still stands) and suppressed only
  for `snapshot_unstable` and `invalid_proposal`, where the evidence itself can't be trusted.

`reconciliation_run`: `status = 'aborted'` only for the anomaly holds (`invalid_proposal`,
`snapshot_unstable`, `mass_revoke`) and the Wix/Kisi read aborts; `observation_only`,
`dry_run`, `auto_revoke_off` are intentional and leave `status = 'success'`. `abort_reason`
carries the hold reason whenever anything was proposed, else NULL. `sanity_gate_triggered`
is true for `snapshot_unstable` / `mass_revoke`, and `sanity_gate_resolved` is then false (a
tripped gate always holds).

Every proposal (removal and repair) and every `held_payment_state` record is written to
`reconciliation_proposal` (`migrations/reconcile-proposal-log.sql`) with `decision = 'held'` and
its `hold_reason` (`payment_state_not_removable` for `held_payment_state`).

`config_alert_log` alert types raised by the sweep — all de-duplicated (no second row while an
unresolved row with the same `alert_type` + `hardware_ref` exists); copy lives in
`core/operator-email-templates.js` `describeConfigAlert` and `admin/public/humanize.js`:

| alert_type | When | `hardware_ref` |
|---|---|---|
| `revoke_invalid_proposal` / `wix_snapshot_anomaly` / `revoke_batch_mass_revoke` | ONE per batch when the decision holds for an anomaly (fallback `revoke_<reason>` for an unmapped anomaly) | `<reason>:<dataSource>:<detail>` |
| `sweep_repair_pending` | Per PAYING member whose door is missing in Kisi | `member:<platformMemberId>` |
| `sweep_removal_pending` | Per member PAYING in neither Wix read whose plan is `ENDED` / `ABSENT` (3B). Suppressed only when the batch is held for `snapshot_unstable` or `invalid_proposal` (kept for `mass_revoke`) | `member:<platformMemberId>` |
| `revoke_holder_lapse_pending` | Per sub-member whose holder's plan is `ENDED` / `ABSENT`. Same suppression rule | `member:<platformMemberId>` |
| `revoke_held_payment_state` | Fix round (F2) — per unit whose Wix payment is `DECLINED` / `PENDING` / `UNKNOWN` (a family is one alert, naming the holder): left alone, never proposed. Same suppression rule | `member:<unitKey>` |
| `kisi_api_unavailable` / `hardware_api_unavailable` | Kisi (or another hardware platform's) assignment read failed — client aborted. Not de-duplicated (plain INSERT, like `wix_api_unavailable`) | `status=<code> code=<code>` |

`finalizeRevoke` (L3) adds `finalize_refused_other_assignments` and
`finalize_refused_shared_user` (see Sub-Member Lifecycle Events above).

**Never written** (removed from `describeConfigAlert` and `humanize.js` in the fix round,
2026-09-10; none was ever committed): `revoke_batch_would_revoke_all`,
`revoke_revalidation_failed`, `revoke_mass_revoke`, `revoke_snapshot_unstable`,
`revoke_auto_revoke_off`, `revoke_auto_revoke_disabled`, `revoke_dry_run`,
`revoke_observation_only`, `revoke_strike_pending`. Every anomaly hold maps to one of the three
types above, and mode / observation-only holds raise no alert. (`revoke_unknown` is kept: it is
`_insertAlertOnce`'s fallback when an alert type is missing.)

**Retired 2026-09-10** (no longer emitted; `humanize.js` keeps their copy for historical
`diagnostic_log` rows): `reconciliation.sanity_gate_triggered`,
`reconciliation.sanity_gate_requery_failed`, `reconciliation.sanity_gate_resolved_proceed`,
`reconciliation.sanity_gate_aborted`. The Wix double read and `revoke-policy` v3's
instability check replace the old requery gate.

### Reconciliation actor format (OB-227, 2026-05-27)

All reconciliation sweep logs and `reconciliation_run.triggered_by_actor_id` rows carry an
actor id of the form `reconciliation-<triggerSource>` where `<triggerSource>` is one of:

| Value | Source |
|---|---|
| `inprocess` | Admin Hub in-process scheduler (`admin/server.js`, 6h interval — OB-196 fallback) |
| `cli` | Local CLI invocation: `node core/reconciliation.js` (developer laptop, ad-hoc) |
| `railway-cron` | Railway Cron service invocation (sniffed via `process.env.RAILWAY_ENVIRONMENT`) |
| `operator-triggered` | Reserved for direct full-sweep invocations from an operator action (rare; per-member operator sync uses `reconcileMember` instead and emits actor `reconcileMember`) |
| `unknown` | Fallback when a caller forgot to pass `triggerSource`. Treat as a bug — every caller must pass a known value. |

Legacy actor `reconciliation-cron` is RETIRED — it masked the trigger source and
was the root cause of OB-227. Greps for the `reconciliation-` prefix continue to
match all of the above.

Per-client `_syncClient` runs inside the sweep inherit the sweep's actor via
`opts.triggeredByActor`, so each `reconciliation_run` row stamps the same
discriminating actor. Operator-triggered `_syncClient` from the manual `/sync/run`
endpoint passes its own `{ type: 'operator', id: <email|id> }` actor and is
unaffected.

---

## Hardware Adapter Events

| Event | Level | Description |
|---|---|---|
| `hw.key.check` | info | Hardware API key validation call |
| `hw.key.invalid` | warn | API key rejected (401) |
| `hw.key.permissions_error` | warn | API key lacks permissions (403) |
| `hw.key.missing` | warn | No API key configured |
| `hw.key.check_failed` | error | Hardware key check returned unexpected error |

---

## Admin Server Events

| Event | Level | Description |
|---|---|---|
| `admin.started` | info | Admin Hub Express server started |
| `admin.member_status_proxy_failed` | warn | Proxy to core engine member-status endpoint failed |
| `admin.unhandled_error` | error | Unhandled Express error caught by global handler |
| `admin.uncaught_exception` | critical | Uncaught exception in admin process |
| `admin.unhandled_rejection` | critical | Unhandled promise rejection in admin process |
| `admin.scheduler.armed` | warn | In-process nightly reconcile scheduler armed at admin boot (OB-197). Persist override locked in `EVENT_REGISTRY.json`. |
| `admin.scheduler.reconcile_start` | warn | In-process scheduler kicked off the nightly reconcile sweep (OB-197). |
| `admin.scheduler.reconcile_complete` | warn | In-process scheduler nightly reconcile sweep finished cleanly (OB-197). |
| `admin.scheduler.reconcile_failed` | error | In-process scheduler nightly reconcile sweep threw (OB-197). Persist override is redundant-but-explicit. |
| `admin.wix_instance_wired` | info | **PERSISTED via EVENT_REGISTRY.json override (2026-05-27).** Wix App signed-instance verified and `clients.platform_instance_id` wired to the operator's client row. |
| `admin.retry.unroutable_event_type` | warn | Phase 1 (2026-09-10, I-9) — a manual retry of an `error_queue` row was refused because its event type is neither a grant nor a revoke (`core/event-routing.js` `jobNameForEventType` → null). Nothing enqueued, the row is NOT marked resolved; single retry answers 422 `{ error, reason }`, bulk retry skips the row and counts it in `skipped`. Emitted by `admin/routes/errors.js` (single + bulk), `admin/routes/members.js` and the operator "Retry now" in `admin/routes/operator.js`. Context: `{ clientId, errorId, eventType, route, reason }` — `route` ∈ `admin.errors.retry`, `admin.errors.bulk_retry`, `admin.members.retry`, `operator.errors.retry`. |
| `admin.retry.unreadable_payload` | warn | Phase 1 (I-9) — same refusal because the stored payload is unreadable: bad JSON, null, an array, or not an object. Nothing enqueued, row NOT resolved. Same routes and context as `admin.retry.unroutable_event_type`. Only reached for grants: a removal is refused first (`admin.retry.revoke_disabled`), whatever its payload. |
| `admin.retry.revoke_disabled` | warn | Phase 1 fix round (2026-09-10, F1 — overrides I-9) — a manual retry of an `error_queue` row whose event type routes to a **revoke** (`jobNameForEventType` → `'revoke'`) was refused. Replaying a stale removal hours or days later can take door access from someone who has since paid, and Phase 1 enables no new removal path. Checked before the payload is read. Nothing enqueued, no UPDATE, the row stays open; single retry answers 422 `{ error, reason: 'revoke_retry_disabled' }` (members.js also returns `errorId`), bulk retry skips the row with a per-row reason. The `error` text is the gym-owner sentence "Retrying a door-access removal is paused while AccessSync's safety checks are rolled out. Nothing was changed — if this person should lose access, remove them in Kisi." Grants still replay as `{ tenantId, standardEvent }`. Same routes and context as `admin.retry.unroutable_event_type`. |

### Admin client/location mutation events (PERSISTED via EVENT_REGISTRY.json override, 2026-05-27)

These admin-panel (owner) mutations were previously suppressed-by-default after OB-176 dropped info-level events. Restored to persist so Builder can see lifecycle changes in the trace timeline.

| Event | Level | Description |
|---|---|---|
| `admin.client_created` | info | Owner created a new client account from Admin Panel |
| `admin.client_archived` | info | Owner archived a client (soft-delete via `archived_at`) |
| `admin.client_restored` | info | Owner restored a previously archived client |
| `admin.client_deleted` | info | Owner hard-deleted a client record |
| `admin.api_key_set` | info | Owner saved a client-level hardware API key (org default) |
| `admin.location_created` | info | Owner created a new location for a client |
| `admin.location_reactivated` | info | Owner reactivated a previously suspended location |
| `admin.location_activated` | info | Owner activated a location (lifecycle gate) |
| `admin.location_api_key_set` | info | Owner saved a per-location hardware API key override |
| `admin.activate_location_done` | info | Activate-location workflow completed successfully |
| `admin.lapse_trigger` | info | Owner triggered location-lapse suspend/activate path |

### Admin sub-member mutation events (PERSISTED via EVENT_REGISTRY.json override, 2026-05-27)

Member Hub family-plan workflow events (DR-040 + DR-044). Restored to persist so sub-member draft/submit/revoke history shows in the trace timeline.

| Event | Level | Description |
|---|---|---|
| `admin.sub_member_added` | info | Sub-member draft row inserted under a holder |
| `admin.sub_member_updated` | info | Sub-member draft fields updated |
| `admin.sub_member_deleted` | info | Sub-member draft hard-deleted (status='draft' path per DR-044) |
| `admin.sub_member_revoke_queued` | info | Submitted/active sub-member revoke job enqueued (entering 'removing' state per DR-044) |
| `admin.sub_member_removed` | info | Sub-member removal pathway summary line |
| `admin.sub_member_grant_queued` | info | Submitted sub-member draft promoted — grant job enqueued |
| `admin.sub_members_submitted` | info | Holder submitted N sub-member drafts (batch) |
| `admin.holder_claim_slot_queued` | info | Holder claimed an open sub-member slot for themselves — grant enqueued |
| `admin.holder_release_slot_queued` | info | Holder released their claimed slot — revoke enqueued |

---

## Operator Routes Events (PERSISTED via EVENT_REGISTRY.json override, 2026-05-27)

Operator-portal (per-client operator scope) mutation events. All persisted-by-override so the operator sees plan-mapping/save/sync activity in the trace timeline.

| Event | Level | Description |
|---|---|---|
| `operator.sync.granted` | info | Per-mapping reconcile granted a hardware role for a member (mapping_activated or group_added context) |
| `operator.sync.revoked` | info | Per-mapping reconcile revoked a hardware role for a member (mapping_deactivated or group_removed context) |
| `operator.sync.revoke_skipped` | info | Revoke skipped because other-mapping grants still hold access for the same group |
| `operator.sync.manual_run` | info | Operator triggered an ad-hoc per-client sync run |
| `operator.location.reactivated` | info | Operator reactivated a location and mapping fan-out completed |
| `operator.location.apikey_set` | info | Operator saved a per-location hardware API key from the operator portal |
| `operator.retry.pending_hardware` | info | Operator triggered retry of pending_hardware members for a client |
| `operator.setup.bypass_accepted` | info | Operator bypass during onboarding accepted (owner PIN flow) |
| `operator.setup.client_upserted` | info | Onboarding upserted (created or updated) the operator's client row |
| `operator.setup.location_created` | info | Onboarding step created the operator's first location |
| `operator.setup.apikey_set` | info | Onboarding step set the operator's hardware API key |
| `operator.setup.location_activated` | info | Onboarding step activated the location (optional `created_bs` flag when a billing_subscriptions row was created in the same call) |
| `operator.apikey.rotated` | info | Operator rotated the client-level hardware API key |
| `operator.notification.updated` | info | Operator updated `notification_email` |
| `operator.member.unlock` | info | Operator unlocked a stuck `in_flight` member back to `recovery_pending` (OB-202 path) |
| `operator.member_sync.run` | info | Operator triggered per-member reconcile |
| `operator.member.welcome_email_resent` | info | Operator manually resent the access_ready email to one member (Members page kebab menu) |
| `operator.member.resend_welcome_email_failed` | error | Manual welcome-email resend threw (DB error, template error) — distinct from a Resend delivery failure, which `sendMemberEmail` already logs as `email.member.failed` |

---

## Activity Events (admin mutation actions)

| Event | Level | Description |
|---|---|---|
| `plan_mapping.created` | activity | Operator created a new plan mapping |
| `plan_mapping.updated` | activity | Operator updated a plan mapping |
| `plan_mapping.deleted` | activity | Operator deleted a plan mapping |
| `api_key.saved` | activity | Operator saved a hardware API key |
| `api_key.rotated` | activity | Operator rotated/replaced a hardware API key |
| `location.created` | activity | Operator created a new location |
| `location.suspended` | activity | Operator suspended a location |
| `location.activated` | activity | Operator reactivated a location |
| `member.synced` | activity | Operator triggered per-member reconcile |
| `error.retried` | activity | Operator manually retried a dead-lettered job |
| `client.updated` | activity | Client settings updated |

---

## Logger Internal Events

| Event | Level | Description |
|---|---|---|
| `logger.diagnostic_log_write_failed` | error | diagnostic_log INSERT failed — written to stdout only |
| `activity.write_failed` | error | activity_event INSERT failed — written to stdout only |

---

## Member Email Events (DR-052, 2026-07-05)

Member-facing branded email pipeline (`core/member-mailer.js` + queue-worker hooks).
Send outcomes are auditable in `member_email_log`; these events cover the decision trail.

| Event | Level | Description |
|---|---|---|
| `email.member.sent` | info | Branded member email handed to Resend (resendId recorded on member_email_log) |
| `email.member.suppressed` | info | Send skipped — dedup hit or synthetic source not on the allow-list |
| `email.member.skipped_disabled` | info | Send skipped — client's member_emails_enabled toggle is off, or no recipient address |
| `email.member.failed` | warn | Send attempt failed (Resend error / exception) — grant/revoke job unaffected |

## Operator Alert Email Events (2026-07-25)

AccessSync-branded operator alerts (`core/operator-mailer.js`). All six alert types —
hardware key, orphaned groups, archived plans, blocked traffic, member failure, and the
nightly digest — route through this one send path.

| Event | Level | Description |
|---|---|---|
| `email.operator.sent` | info | Operator alert handed to Resend |
| `email.operator.failed` | error | Send attempt failed (Resend error / exception) — never fails the caller |
| `email.operator.no_recipient` | warn | No notification email resolved for this client or owner fallback |
| `health.alert_suppressed` | info | Repeat hardware-key alert withheld by the escalate-then-cool-down rule (every run for the first 24h of a failure, then once per day) |

## Email Branding Activity Events (DR-052)

| Event | Level | Description |
|---|---|---|
| `email_branding.updated` | activity | Operator saved member-email branding (colors / enabled toggle) |
| `email_branding.logo_uploaded` | activity | Operator uploaded a member-email logo |
| `email_branding.test_sent` | activity | Operator sent a branded test email to the admin contact |
