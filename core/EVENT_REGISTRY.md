# EVENT_REGISTRY.md — AccessSync Log Event Taxonomy
**Governed by:** DR-038  
**Owner:** NOVA / KEEPER  
**Format:** `namespace.action[.qualifier]`

Every log event emitted by `log.*()` in production code is listed here.
New events require an entry before shipping. Events without entries are flagged by the no-raw-console P3 test.

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

---

## Queue Worker Events

| Event | Level | Description |
|---|---|---|
| `queue.job.start` | info | Job dequeued from BullMQ and processing started |
| `queue.job.complete` | info | Job completed successfully |
| `queue.job.failed` | error | Job failed — includes lastStep and error details |
| `queue.job.missing_trace_id` | error | Job payload has no traceId — rejected before processing (enforcement gate) |
| `queue.grant.plan_unknown` | warn | No active plan mappings found for this planId |
| `queue.grant.no_api_key` | warn | No hardware API key configured for this client/location |
| `queue.grant.pending_start` | info | Grant parked as pending_start — plan has future start date |
| `queue.revoke.skip.no_identity` | info | Revoke skipped — member has no identity record |
| `queue.unknown_job_name` | warn | Job name not in known set (grant/revoke) |

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

## Sub-Member Lifecycle Events (DR-044)

| Event | Level | Description |
|---|---|---|
| `member.sub_member.soft_deleted` | info | DR-044: Sub-member finalize succeeded — `sub_member_status='deleted'`, PII NULL'd. Atomic UPDATE matched expected `'removing'` prior state. Lands in `member_access_log` as `event_type='sub_member_soft_deleted'`. |
| `member.sub_member.soft_delete_idempotent_skip` | warn | DR-044: Finalize UPDATE matched 0 rows on a sub-member (plan_holder_id not NULL). Race or replay — already in terminal `'deleted'` state or never reached `'removing'`. Diagnostic only; not an error. |

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
