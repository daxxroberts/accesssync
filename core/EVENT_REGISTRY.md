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
| `grant.group_not_found` | warn | Hardware group 404 — group flagged, member gets partial access |
| `grant.partial_failure` | warn | Some groups succeeded, some failed — partial access granted |
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
| `wix.parse.event_type_normalized` | info | Suppressed (DR-054) — Layer 2 mapped a raw Wix event name onto a standard eventType. Fires on every inbound webhook. |

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
| `kisi.role.conflict_unresolvable` | warn | 409 on assignRole but existing record could not be retrieved |
| `kisi.role.removing` / `kisi.role.removed` / `kisi.role.remove_failed` | info / info / error | removeRole lifecycle (revoke flow) |
| `kisi.role.remove_skipped_already_gone` | info | OB-147: 404 on removeRole — role already gone, treated as idempotent success |
| `kisi.managed_assignments.fetched` / `kisi.managed_assignments.fetch_failed` | info / error | getManagedRoleAssignments — reconciliation Kisi-side data fetch |
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
| `reconciliation.sub_member_holder_lapsed` | info | **PERSISTED via EVENT_REGISTRY.json override.** OB-247 Pass 1.5 — a sub-member's holder is no longer `active` (billing lapse or full revoke). A synthetic `plan.cancelled` revoke has been queued for ONE of the sub-member's active source rows (one event per source). Context: `{ subAccessId, platformMemberId, sourcePlanId, jobId, traceId, sweepTraceId }`. |
| `reconciliation.sub_member_holder_lapsed_queue_failed` | error | OB-247 Pass 1.5 — failed to enqueue the synthetic revoke job for a specific sub-member source. Other source revokes in the same sweep are unaffected. Investigate BullMQ/Redis health. |
| `reconciliation.pass_1_5_complete` | info | OB-247 Pass 1.5 finished for a client. Reports `lapsedSubsFound` (count of sub-members whose holder is non-active) and `subMemberRevokesQueued` (total revoke jobs enqueued across all source plans). |
| `reconciliation.pass_1_5_failed` | error | OB-247 Pass 1.5 top-level error — query failed or unhandled exception. Sweep continues to Pass 2/3 for this client. |
| `reconciliation.pass_3_aborted_kisi_unavailable` | warn | OB-249 Pass 3 — `listAllUsers` threw. Outage short-circuit: Pass 3 aborts for this client; Pass 1, Pass 1.5, and the grant queue continue. Re-attempted next sweep. |
| `reconciliation.pass_3_skipped_unsupported_platform` | info | OB-249 Pass 3 — `hardware_platform !== 'kisi'` (Seam stub doesn't implement `listAllUsers`). Skipped, no action. |
| `reconciliation.kisi_user_disappeared_first_sighting` | info | OB-249 Pass 3 — bulk Kisi user-list missing this member's `hardware_user_id` for the FIRST sweep. Two-strike marker `kisi_user_disappeared_observed_at` set. No destructive action. |
| `reconciliation.kisi_user_disappeared_confirmed` | warn | **OB-249 Pass 3 — SECOND consecutive sweep with the member's Kisi user missing. Synthetic plan.cancelled queued per active source. Operator manually deleted the user in Kisi dashboard (or persistent Kisi failure).** |
| `reconciliation.kisi_user_recovered` | info | OB-249 Pass 3 — the user that was previously marked missing is back in Kisi. Two-strike marker cleared (`kisi_user_disappeared_observed_at = NULL`). Transient outage or operator restored the user. |
| `reconciliation.role_assignment_drifted` | warn | **OB-249 Pass 3 — user exists in Kisi but one of our DB-active source rows is missing its expected `(user_id, group_id)` role assignment.** Operator removed a specific role via Kisi dashboard. Per-source synthetic plan.cancelled queued. A12 universe filter applied (only groups AccessSync manages). |
| `reconciliation.pass_3_revoke_queue_failed` | error | OB-249 Pass 3 — BullMQ enqueue failed for a specific drift-derived revoke. Other Pass 3 revokes in same sweep unaffected. Investigate Redis health. |
| `reconciliation.pass_3_complete` | info | OB-249 Pass 3 finished for a client. Reports: `outage`, `totalKisiUsersFetched`, `disappearedFirstSighting`, `disappearedConfirmed`, `roleDrifted`, `userRecovered`. |
| `kisi.list_users.fetched` | info | OB-249 — Kisi `listAllUsers` paginated through all users in the org. `totalUsers` count included. |
| `kisi.list_users_no_key` | warn | OB-249 — `listAllUsers` called without an API key. Returns empty array, no throw. |
| `kisi.list_users_failed` | error | OB-249 — Kisi bulk user-list paginate threw at some offset. Caller (Pass 3) catches and treats as outage. |

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
