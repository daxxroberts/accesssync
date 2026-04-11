---
screen_id: S08
screen_name: Access Log
file: admin/views/pages/access.ejs
route: /access
method: GET
auth: Operator JWT
data_required: clientId, access-log (paginated), access-stats (hourly)
role: operator (access-log-viewer)
api_calls: GET /operator/:clientId/access-log, GET /operator/:clientId/access-stats
status: built
---

# IRIS Map — S08: Access Log

## Purpose
Full audit log of all member access lifecycle events (provisioned, disabled, restored, revoked, error). Includes a 30-day bar chart of event volume, event type filters, location filter, and CSV export.

## Layout
Topbar + subnav + content (max-width 1200px). Sections: stats strip → bar chart → filter tags → log table.

## Elements

### Stats Strip
| Element | Type | Content |
|---------|------|---------|
| Total Events | Stat card | Count of events in range |
| Grants | Stat card | grants_completed count |
| Revokes | Stat card | revokes_completed count |
| Errors | Stat card | errors_count |

### Bar Chart
| Element | Type | Content |
|---------|------|---------|
| 30-day bar chart | Chart (CSS bars) | One bar per day, height = event count |
| Bar tooltip | Hover tooltip | Count for that day |
| Chart labels | X-axis labels | Day labels (abbreviated) |
| Filtered bars | Visual | Bars for non-selected event types fade to 0.3 opacity |

### Filter Tags
| Element | Type | Content |
|---------|------|---------|
| All filter | Tag (active = brand) | Shows all event types |
| Granted | Tag (active = sage) | event_type = provisioned / granted |
| Revoked | Tag (active = red) | event_type = revoked |
| Error | Tag (active = red) | event_type = error |
| Denied | Tag (active = amber) | event_type = denied |
| Location filter | Select/tag | Filter by location |

### Log Table
| Element | Type | Content |
|---------|------|---------|
| Member | Column | platform_member_id (no name — same gap as S07) |
| Event type | Column | Pill: provisioned / disabled / restored / revoked / error |
| Location | Column | Location name |
| Door | Column | Hardware group / door name |
| Credential type | Column | pin / qr / kisi_app |
| Timestamp | Column | created_at formatted |
| Pagination | Controls | Page prev/next or infinite scroll |

### CSV Export
| Element | Type | Content |
|---------|------|---------|
| Export button | Button | "Export CSV" — exports current filtered view |

## States

| State | Trigger | Display |
|-------|---------|---------|
| No events | No webhooks processed | Empty state + chart with all-zero bars |
| Filtered view | Filter tag active | Chart bars filtered + table rows filtered |
| Loading | API in flight | Skeleton or spinner |
| Export in progress | Export clicked | Download triggers |

## Navigation
- Subnav: tab within operator dashboard
- No sub-navigation within this screen

## Data Contracts

| Action | Endpoint | Returns |
|--------|----------|---------|
| Load log | `GET /operator/:clientId/access-log?page=X&type=Y&locationId=Z` | Paginated member_access_log rows |
| Load stats | `GET /operator/:clientId/access-stats` | Hourly/daily aggregated counts for chart |
| Export CSV | `GET /operator/:clientId/access-log/export` | CSV download |

## Known Gaps
- Member column shows `platform_member_id` — no name display (same root cause as S07)
