---
screen_id: S09
screen_name: Sync Status (Operator)
file: admin/views/pages/sync-status.ejs (operator view — distinct from member-facing S13)
route: /sync-status
method: GET
auth: Operator JWT
data_required: clientId, member_access_state summary, error_queue
role: operator
status: built
---

# IRIS Map — S09: Sync Status (Operator)

## Purpose
Provisioning health overview for the operator. Shows counts by access status, error queue for this client, and quick actions (dismiss, retry). Not a real-time live sync screen — shows current snapshot from AccessSync's DB (DR-006).

## Layout
Topbar + subnav + content. Status summary cards + error list.

## Elements

### Status Summary Cards
| Element | Type | Content |
|---------|------|---------|
| Active members card | Stat card | Count: status = active |
| Pending members card | Stat card | Count: status = pending_hardware or pending_sync |
| Failed members card | Stat card (red) | Count: status = failed |
| Disabled members card | Stat card | Count: status = disabled |

### Sync Health Indicator
| Element | Type | Content |
|---------|------|---------|
| Last sync timestamp | Label | `clients.last_sync_at` |
| Webhook health | Pill | LIVE / WARN / ERROR based on `last_wix_webhook_at` |

### Error Queue (Operator view)
| Element | Type | Content |
|---------|------|---------|
| Error list | Cards | One per error_queue row for this client |
| Error card: member | Label | platform_member_id |
| Error card: event type | Badge | plan.purchased, booking.confirmed, etc. |
| Error card: error reason | Body text | `error_queue.error_reason` |
| Error card: plan name | Label | `error_queue.plan_name` |
| Error card: door name | Label | `error_queue.door_name` |
| Error card: timestamp | Subtext | `created_at` |
| Dismiss button | Button (secondary) | Marks error resolved, adds dismiss_note |
| Retry button | Button (primary) | Re-queues the job |
| Error count badge | Badge | Total errors for this client |

## States

| State | Trigger | Display |
|-------|---------|---------|
| All clear | error_queue empty | "No errors — all members provisioned" |
| Errors present | error_queue has rows | Error card list |
| Failed members | status = failed count > 0 | Red stat card with count |
| Pending hardware | pending_hardware count > 0 | Amber stat card with "Awaiting setup" note |
| Webhook WARN/ERROR | `last_wix_webhook_at` stale | Warning inline on health indicator |

## Navigation
- Subnav: tab within operator dashboard
- Dismiss/Retry: in-place update, no route change
- Failed member row: link to S07 Members for that member (if implemented)

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load status counts | `GET /operator/:clientId/sync-status` | GET |
| Load error queue | `GET /operator/:clientId/errors` | GET |
| Dismiss error | `PATCH /operator/:clientId/errors/:errorId/dismiss` | PATCH |
| Retry error | `POST /operator/:clientId/errors/:errorId/retry` | POST |

## Known Gaps
- **FUNNEL-G-07:** No "what happens next" guidance for pending_hardware members — operator sees count but no action path shown
- No direct link from failed member error card to the member's timeline in S07
