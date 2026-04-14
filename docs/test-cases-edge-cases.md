# Edge Case Test Cases

Living verification document for edge-case scenarios across Kisi Groups, Wix Plans, and AccessSync Mappings.

---

## Kisi Group Changes (K-2)

- [ ] Health check detects deleted group -> `plan_mapping_groups.health_status = 'not_found'`, mapping stays active
- [ ] New member buys plan with one dead group + one live group -> partial access granted (live group only)
- [ ] Grant loop continues past dead group, does not throw (unless ALL groups dead)
- [ ] All groups dead on a single plan -> job dead-letters, `config_alert_log` entry written
- [ ] `plan-mapping-resolver` skips `health_status = 'not_found'` groups in WHERE clause
- [ ] Operator removes dead group wire -> MRA rows + `member_access_sources` rows cleaned up, junction row deleted
- [ ] Operator connects new group after removing dead one -> `syncMappingMembers` provisions all active members
- [ ] Health check detects recovered group (previously not_found, now alive) -> resets `health_status = 'ok'`
- [ ] Wire graph shows amber dashed wire on dead group with member count
- [ ] Wire graph shows warning icon + "Group not found" subtitle on dead group node
- [ ] Classic UI shows amber warning on stale group with affected member count
- [ ] Classic UI header mini-tags show stale styling for dead groups
- [ ] Operator email sent with group name + affected member count per dead group

## Wix Plan Changes

- [ ] Health check detects archived plan -> `plan_mappings.wix_status = 'archived'`
- [ ] Health check detects previously-archived plan reappearing -> resets `wix_status = 'active'`
- [ ] Wire graph shows amber "Archived" pill next to plan name
- [ ] Wire graph shows archived subtitle text on plan node
- [ ] Classic UI shows amber "Archived" badge in plan card header
- [ ] Classic UI shows archived subtitle notice in plan card body
- [ ] Archived plan members retain access (no revocation triggered)
- [ ] Operator email informational, not urgent — includes plan names + affected member counts
- [ ] Health check skips Wix reconciliation when no `wix_api_key` or `wix_instance_id`

## Unknown Plan (W-1)

- [ ] Unknown plan webhook -> `error_queue` row created with `error_code = 'PLAN_NOT_MAPPED'`
- [ ] Operator notification email with actionable message + plan ID + recommended action
- [ ] `queue-worker.js` calls `retryEngine.handleFailure()` for unknown plans (not silent return)
- [ ] Error object includes `userMessage` and `action` fields for operator display
- [ ] Sync-status page shows amber "Your access is being set up" message (not red error)
- [ ] Sync-status page handles `data.lastEvent?.errorCode === 'PLAN_NOT_MAPPED'` -> shows `state-setup`
- [ ] Sync-status freshness re-check also handles PLAN_NOT_MAPPED state
- [ ] Error Queue panel shows plan ID + recommended action for PLAN_NOT_MAPPED errors

## Disconnect Safety (M-6)

- [ ] Wire graph: disconnect with active members -> confirmation shows member count from API
- [ ] Wire graph: disconnect with zero members -> lighter confirmation message
- [ ] Wire graph: disconnect dead group -> specific message mentioning group is no longer available
- [ ] Classic UI: remove group fetches affected member count before showing modal
- [ ] Classic UI: dead group removal message includes assignment count + remap suggestion
- [ ] Classic UI: normal group removal message includes member count
- [ ] Cancel on confirmation -> no disconnect (both UIs)

## Multi-Source Safety (C-4)

- [ ] Member on Plan A + Plan B, both mapped to same group -> unmap Plan A -> member keeps access
- [ ] Member on Plan A only -> unmap Plan A -> member loses access (correct)
- [ ] `syncMappingMembers` revoke path checks MRA count across ALL mappings before Kisi removeRole

## API Key Missing (M-4)

- [ ] Wire graph: connect group when no API key -> amber toast warning from `response.warning`
- [ ] Classic UI: connect group when no API key -> amber toast warning
- [ ] Members NOT provisioned when no API key (correct — parked as `pending_hardware`)

## Schema

- [ ] `plan_mapping_groups.health_status` column exists with default `'ok'`
- [ ] `plan_mappings.wix_status` column exists with default `'active'`
- [ ] Migration `edge-case-health-status.sql` runs cleanly on existing data
- [ ] `schema.sql` canonical definitions match migration columns
