---
screen_id: S06
screen_name: Plan Mapping
file: admin/views/pages/plan-mapping.ejs
route: /plan-mapping
method: GET
auth: Operator JWT
data_required: clientId, locationId, plan_mappings, kisi-groups
role: operator
api_calls: GET /operator/:clientId/locations/:locationId/mappings, GET /operator/:clientId/kisi-groups
writes: PATCH /operator/:clientId/plan-mappings/:mappingId
status: built
---

# IRIS Map — S06: Plan Mapping

## Purpose
Maps Wix pricing plans and booking services to hardware access groups (doors). One plan → one or more doors. Operator defines which gym membership grants which door. This is the configuration that drives all grant/revoke decisions.

## Layout
Topbar + subnav + content. Sections: info banner, unmapped plans alert (if any), "Pricing Plans" section, "Booking Services" section. Plan cards with door assignment controls.

## Elements

### Info Banner
| Element | Type | Content |
|---------|------|---------|
| Info icon | Icon | Blue info icon |
| Explanation text | Body | "Match each plan to the door(s) it grants access to. Unmapped plans are not managed by AccessSync." |

### Unmapped Alert (conditional)
| Element | Type | Content |
|---------|------|---------|
| Alert banner | Warning card | "X plans are unmapped. Members who purchase these will be parked until mapped." |
| Alert count | Badge (red) | Count of unmapped plans |

### Section Headers
| Element | Type | Content |
|---------|------|---------|
| "Pricing Plans" header | Section label | With count badge: mapped (blue) / unmapped (red) |
| "Booking Services" header | Section label | With count badge: service (purple) |

### Plan Cards (one per Wix plan or booking service)
| Element | Type | Content |
|---------|------|---------|
| Plan name | H4 | `plan_mappings.plan_name` |
| Plan ID | Subtext | `plan_mappings.source_plan_id` |
| Door assignment | Multi-select or dropdown | `plan_mapping_groups` — one or more doors |
| Door name label | Label | `door_name` per group |
| Status toggle | Toggle | Managed / Not managed (active / excluded) |
| Duplicate-group warning | Inline alert | If two plans share same door — "Another plan already grants this door. AccessSync handles overlapping access safely." |
| Multi-member toggle | Toggle | allow_multiple (DEFERRED post-HOG — hidden or disabled) |
| Save button | Button (primary) | Saves mapping changes |

## States

| State | Trigger | Display |
|-------|---------|---------|
| Unmapped plan | hardware_group_id = null | Red "Unmapped" badge on plan card |
| Mapped plan | hardware_group_id set | Shows door name(s) |
| Excluded plan | status = excluded | "Not managed" label, greyed card |
| No groups available | Kisi API returns empty | "No doors found" message — prompt to check API key |
| Duplicate group warning | Two plans share one group | Amber inline warning on affected cards |
| Multi-member gate | allow_multiple active | Hidden/disabled post-HOG |
| Save success | PATCH succeeds | Toast + card updates |
| Save fail | PATCH fails | Inline error |

## Navigation
- Subnav: tab within operator dashboard
- Saving a plan mapping triggers pending_hardware re-queue for members on that plan (WIRE-G-01 — not yet built)

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load mappings | `GET /operator/:clientId/locations/:locationId/mappings` | GET |
| Load hardware groups | `GET /operator/:clientId/kisi-groups` | GET |
| Update mapping | `PATCH /operator/:clientId/plan-mappings/:mappingId` | PATCH |
| Toggle status | `PATCH /operator/:clientId/plan-mappings/:mappingId` | PATCH (status field) |

## Key Rules
- Unmapped plan: member purchases → `pending_hardware` state. Stays parked until plan is mapped.
- Excluded plan (status = excluded): webhook received → plan dropped. No error. No pending.
- Multi-group: one plan can map to multiple doors via `plan_mapping_groups`. Each door gets its own `member_role_assignments` row.
- **WIRE-G-01:** On PATCH save, must trigger pending_hardware re-queue for all members on that client with `pending_plan_id` matching this plan — NOT YET BUILT.
