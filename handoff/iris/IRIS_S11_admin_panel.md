---
screen_id: S11
screen_name: Admin Panel
file: admin/views/pages/admin-panel.ejs
route: /admin-panel
method: GET
auth: Operator JWT
data_required: clientId, admin users list (Wix-synced — not yet live)
role: operator (admin-management role)
status: built — mock data (Wix admin sync not live)
---

# IRIS Map — S11: Admin Panel

## Purpose
Shows the gym's Wix administrators who have operator access to the AccessSync portal. Allows operator to see who else can access the portal. Admin user sync from Wix is not yet implemented — currently displays mock/hardcoded data.

## Layout
Topbar + subnav + content (max-width 720px). Logged-in strip + admin user list + info toggle section.

## Elements

### Logged-In Strip
| Element | Type | Content |
|---------|------|---------|
| Avatar | Circle | Initials from logged-in operator name |
| Name | H4 | Logged-in operator name |
| Detail | Subtext | Email or Wix account |
| Role badge | Badge | "Owner" (brand color) |

### Admin List
| Element | Type | Content |
|---------|------|---------|
| Admin rows | List items | One per Wix admin who has portal access |
| Avatar | Circle | Initials, color-coded by role |
| Name | Label | Admin display name |
| Email | Subtext | Admin email |
| Role badge | Badge | Owner (brand) / Admin (muted) |

### Info Toggle
| Element | Type | Content |
|---------|------|---------|
| "About permissions" button | Toggle button | Expands info panel |
| Info panel | Collapsible | Explains owner vs admin role differences |
| Info items | List | Role permission descriptions with icons |

## States

| State | Trigger | Display |
|-------|---------|---------|
| Mock data | Wix admin sync not live | Hardcoded admin list shown |
| Single admin | Only one Wix admin | Single row list |
| Info closed | Default | Info panel collapsed |
| Info open | Toggle clicked | Info panel expanded |

## Navigation
- Subnav: tab within operator dashboard
- No outbound navigation from this screen

## Data Contracts
- **NOT YET LIVE.** Wix admin sync endpoint not implemented.
- Planned: `GET /operator/:clientId/admins` → Wix API for site contributors with operator role

## Known Gaps
- Admin list is mock data — Wix admin sync not built
- No ability to add/remove admin access from this screen (read-only when live)
- `dismissed_by` field in error_queue is hardcoded 'admin' — not scoped to actual operator identity
