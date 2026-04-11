---
screen_id: S10
screen_name: Error Queue (Operator — embedded in S09)
file: admin/views/pages/sync-status.ejs
route: Component of /sync-status
method: —
auth: Operator JWT
role: operator
status: built (component, not standalone screen)
note: S10 documents the error queue component. The full screen is S09.
---

# IRIS Map — S10: Error Queue Component (Operator)

## Purpose
Dismissable, retryable error queue showing provisioning failures for this client. Embedded within the Sync Status screen (S09). Operators use this to triage members who failed to provision.

## Elements

| Element | Type | Content |
|---------|------|---------|
| Error count header | H3 + badge | "Errors (X)" |
| Error card | Card | One per error_queue row |
| — Member ID | Label | `platform_member_id` |
| — Event type | Badge | webhook event that failed |
| — Plan name | Label | `error_queue.plan_name` |
| — Door name | Label | `error_queue.door_name` |
| — Error reason | Body | `error_queue.error_reason` (plain_message in API response) |
| — Retry count | Subtext | "Retried X times" |
| — Timestamp | Subtext | `created_at` |
| Dismiss button | Button (secondary) | Marks status = resolved. Prompts for dismiss_note. |
| Retry button | Button (primary) | Re-queues job to BullMQ. Increments retry_count. |
| Empty state | Message | "No errors — all members provisioned" |

## Dismiss Flow
1. Operator clicks Dismiss
2. Optional text input: dismiss note (stored in `error_queue.dismiss_note`)
3. `PATCH /operator/:clientId/errors/:errorId/dismiss`
4. Card removed from list. `status = resolved`, `resolved_at` set, `dismissed_by = 'admin'` (current value — not yet scoped to operator identity).

## Retry Flow
1. Operator clicks Retry
2. Confirmation dialog: "Re-queue this member?"
3. `POST /operator/:clientId/errors/:errorId/retry`
4. Job re-queued to BullMQ via standard grant flow
5. Card shows "Retrying..." state while job is in flight

## States

| State | Trigger | Display |
|-------|---------|---------|
| Errors present | error_queue has rows | Error cards shown |
| Empty | No errors | "No errors" empty state |
| Retrying | Job re-queued | Card enters "in_flight" display |
| Retry success | Member provisions | Card removed (status = active) |
| Retry fail again | Job fails again | Card returns with updated error |
| Dismissed | Operator dismisses | Card removed immediately |
