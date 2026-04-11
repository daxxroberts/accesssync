---
screen_id: S03
screen_name: Dashboard Overview
file: admin/views/pages/dashboard.ejs
route: /dashboard
method: GET
auth: Operator JWT
data_required: clientId (query param), client record, locations, alerts
role: operator
api_calls: GET /operator/:clientId, GET /operator/:clientId/locations, GET /operator/:clientId/alerts
status: built
---

# IRIS Map — S03: Dashboard Overview

## Purpose
Primary operator landing screen after setup. Shows gym health status at a glance: platform connections, location subscription status, webhook health, recent errors, and quick navigation to all operator screens.

## Layout
Topbar (logo + site name + dark mode toggle) + subnav tabs + main content column (max-width 900px). Content divided into labeled sections with card components.

## Elements

### Client Header Card
| Element | Type | Content |
|---------|------|---------|
| Gym name | H2 | `client.name` |
| Site URL | Subtext | `client.site_url` |
| Add Location button | Button (primary, brand) | "+ Add Location" → location creation form |

### Platform Connections Section
| Element | Type | Content |
|---------|------|---------|
| Wix connection chip | Status chip | "Wix" + LIVE/WARN/ERROR pill based on `last_wix_webhook_at` |
| Hardware connection chip | Status chip | "Kisi" or "Seam" + connection status |
| Connection status logic | Computed | LIVE = webhook < 24h ago; WARN = 24-72h; ERROR = >72h or null |

### Locations Section
| Element | Type | Content |
|---------|------|---------|
| Location cards | Repeating card | One per location: name, subscription_status pill, hardware platform, tier |
| Status pills | Pill | active (sage) / inactive (muted) / lapsed (red) |
| Location settings link | Link button | "Configure" → S05 Locations |

### Recent Errors Section
| Element | Type | Content |
|---------|------|---------|
| Error count badge | Badge | Count from error_queue for this client |
| Error preview list | List | Up to 3 recent errors: member, event_type, error_reason |
| "View all errors" link | Link | → S09 Sync Status / Error Queue |

### Quick Navigation Cards
| Element | Type | Content |
|---------|------|---------|
| Plan Mapping card | Nav card | Icon + "Plan Mapping" → S06 |
| Members card | Nav card | Icon + "Members" → S07 |
| Access Log card | Nav card | Icon + "Access Log" → S08 |
| Settings card | Nav card | Icon + "Settings" → System Config |

## Subnav Tabs (operator-nav.js)
Overview · Locations · Plan Mapping · Members · Access · Sync Status · Admin

## States

| State | Trigger | Display |
|-------|---------|---------|
| No locations | New operator bypassed setup | Empty locations section, "Add Location" prominent |
| Wix webhook LIVE | `last_wix_webhook_at` < 24h | Green LIVE pill |
| Wix webhook WARN | 24-72h since last webhook | Amber WARN pill |
| Wix webhook ERROR | >72h or null | Red ERROR pill |
| Active errors | error_queue has items | Error count badge + preview list |
| No errors | error_queue empty | "No errors" placeholder |
| Session expired | 401 from apiFetch | Session expired modal (role-aware) |

## Navigation
- All subnav tabs accessible from here
- "Add Location" → location creation modal/form
- Error preview → S09 Sync Status
- Quick nav cards → respective screens

## Data Contracts

| Data | Endpoint | Notes |
|------|----------|-------|
| Client record | `GET /operator/:clientId` | name, site_url, hardware_platform, last_wix_webhook_at |
| Locations | `GET /operator/:clientId/locations` | subscription_status, tier, hardware_platform |
| Alerts | `GET /operator/:clientId/alerts` | Recent config alerts |
| Error count | `GET /operator/:clientId/errors` | Count only for badge |
