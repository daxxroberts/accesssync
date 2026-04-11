---
screen_id: S07
screen_name: Members
file: admin/views/pages/members.ejs
route: /members
method: GET
auth: Operator JWT
data_required: clientId, member list with access state
role: operator
api_calls: GET /operator/:clientId/members (returns platform_member_id + access_status, NO name/email)
status: built — mock data for name display
---

# IRIS Map — S07: Members

## Purpose
Lists all gym members AccessSync has seen (from webhooks), with their current access status. Allows search by name or email, view of member timeline, and manual sync trigger.

## Layout
Topbar + subnav + content. Search bar + filter strip + member list. Slide-out timeline drawer per member.

## Elements

### Search Bar
| Element | Type | Content |
|---------|------|---------|
| Search input | Input (text) | "Search by name or email..." |
| Search button | Button or auto-search | Filters member list client-side |

### Filter Strip
| Element | Type | Content |
|---------|------|---------|
| All tab | Filter tag | Shows all members |
| Active tab | Filter tag | access_status = active |
| Failed tab | Filter tag (red) | access_status = failed |
| Pending tab | Filter tag (amber) | access_status = pending_hardware, pending_sync |
| Disabled tab | Filter tag | access_status = disabled |

### Member List (one row per member)
| Element | Type | Content |
|---------|------|---------|
| Avatar | Circle with initials | Derived from first name (mock or real) |
| Full name | H4 | **MOCK DATA** — hardcoded firstName/lastName in members.ejs lines 256-275. In production: falls back to splitting `platform_member_id`. No Wix name fetch exists. |
| Email | Subtext | **MOCK DATA** — hardcoded in members.ejs. Production: not available from `/operator/:clientId/members` endpoint. |
| Access status pill | Pill | active (sage) / failed (red) / pending (amber) / disabled (muted) |
| Provisioned date | Subtext | `provisioned_at` from member_access_state |
| Timeline button | Icon button | Opens slide-out timeline drawer |
| Sync button | Icon button | Manual sync trigger for this member |

### Timeline Drawer (slide-out)
| Element | Type | Content |
|---------|------|---------|
| Member header | H4 + status | Name + current status |
| Event list | Chronological | member_access_log events: provisioned, disabled, restored, revoked |
| Event badges | Colored dots | Event type colors |
| Close button | × | Closes drawer |

## States

| State | Trigger | Display |
|-------|---------|---------|
| No members | Never received a webhook | Empty state: "No members yet. Webhooks will appear here." |
| Active member | access_status = active | Sage "Active" pill |
| Failed member | access_status = failed | Red "Failed" pill + sync button |
| Pending hardware | access_status = pending_hardware | Amber "Pending" pill + explainer |
| Disabled member | access_status = disabled | Grey "Disabled" pill |
| Search match | Typed query | Filtered list |
| No search results | Query returns empty | "No members match" message |
| Drawer open | Timeline button clicked | Slide-out from right |

## Navigation
- Subnav: tab within operator dashboard
- Timeline drawer: slide-out overlay (no route change)
- Sync button: calls manual sync endpoint

## Data Contracts

| Action | Endpoint | Returns |
|--------|----------|---------|
| Load members | `GET /operator/:clientId/members` | platform_member_id, hardware_platform, access_status, provisioned_at — **NO name or email** |
| Load timeline | `GET /operator/:clientId/members/:memberId/log` | member_access_log events |
| Manual sync | `POST /operator/:clientId/members/:memberId/sync` | Re-queues member |

## Known Gaps
- **Member name display is broken in production.** The endpoint returns `platform_member_id` only. The EJS has hardcoded mock data for the demo. Real production will show split platform_member_id as display name unless a Wix member name fetch is added to the endpoint. This needs a DR and implementation before launch.
- **No email display in production.** Same root cause — endpoint does not fetch from Wix.
- **DR-001 alignment:** Fetching name/email from Wix for display is permitted (DR-001 prohibits *storage*, not on-demand fetch). The implementation gap is the fetch call, not a policy violation.
