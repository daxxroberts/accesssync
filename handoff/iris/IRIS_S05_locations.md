---
screen_id: S05
screen_name: Locations
file: admin/views/pages/locations.ejs
route: /locations
method: GET
auth: Operator JWT
data_required: clientId, locations list, subscription status
role: operator
api_calls: GET /operator/:clientId/locations
status: built
---

# IRIS Map — S05: Locations

## Purpose
View and manage all physical locations under this client. Each location can have its own hardware platform, API key, notification email, and subscription status. Location-level settings override client-level (System Config) settings.

## Layout
Topbar + subnav + content. List of location cards + "+ Add Location" button.

## Elements

### Page Header
| Element | Type | Content |
|---------|------|---------|
| Page title | H1 | "Locations" |
| Add Location button | Button (primary) | "+ Add Location" → opens location creation form/modal |

### Location Cards (one per location)
| Element | Type | Content |
|---------|------|---------|
| Location name | H3 | `locations.name` |
| City / State | Subtext | `locations.city`, `locations.state` |
| Subscription status pill | Pill | active (sage) / inactive (amber) / lapsed (red) |
| Tier badge | Badge | `locations.tier` |
| Hardware platform | Label | `locations.hardware_platform` (or inherits from client) |
| API key status | Indicator | Verified / Not set / Last verified timestamp |
| Notification email | Label | `locations.notification_email` (or inherits) |
| Configure button | Button | Opens location edit form |
| Suspend all / Reactivate all | Button | Bulk action for all members at this location |

### Add / Edit Location Form
| Element | Type | Content |
|---------|------|---------|
| Location name | Input (text) | Required |
| City | Input (text) | Optional |
| State | Input (text) | Optional |
| Tier selector | Select | Base / Pro / Connect |
| Hardware platform | Select | Kisi / Seam (override, null = use client default) |
| Hardware API key | Input (password) | Override key. Null = use client key. |
| Test Connection button | Button | Tests the location-level key |
| Notification email | Input (email) | Override email. Null = use client email. |
| Save button | Button (primary) | Creates or updates location |
| Cancel | Button (secondary) | Closes form without saving |

## States

| State | Trigger | Display |
|-------|---------|---------|
| No locations | New operator | Empty state with "Add your first location" prompt |
| Active subscription | subscription_status = active | Sage pill |
| Lapsed subscription | subscription_status = lapsed | Red pill + warning message |
| API key override set | location has own key | Shows "Custom key" + last verified |
| API key inherits | location key is null | Shows "Using org key" |
| Suspend all | Operator action | All member_access_state for location → disabled |
| Reactivate all | Operator action | Triggers re-provisioning for eligible members |

## Navigation
- Subnav: tab within operator dashboard
- Edit location → form opens inline or modal
- Suspend/reactivate → confirmation dialog before action

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load locations | `GET /operator/:clientId/locations` | GET |
| Create location | `POST /operator/:clientId/locations` | POST |
| Update location | `PATCH /operator/:clientId/locations/:locationId` | PATCH |
| Test location API key | `POST /operator/:clientId/locations/:locationId/test-key` | POST |
| Suspend all | `POST /operator/:clientId/locations/:locationId/suspend` | POST |
| Reactivate all | `POST /operator/:clientId/locations/:locationId/reactivate` | POST |

## Key Rules
- Location API key null → resolved to client API key at runtime. Not shown as "blank" to operator — shown as "Using org key".
- Saving a location API key triggers pending_hardware re-queue for members at that location (WIRE-G-01 — not yet built).
- Lapsed subscription: `location-lapse.js` suspends all members. Reactivation requires subscription to be restored first.
