---
screen_id: S15
screen_name: Admin Hub Dashboard
file: admin/public/index.html + admin/public/app.js
route: /admin/dashboard (index.html shell, JS-rendered)
method: GET
auth: Admin session (Google OAuth → admin JWT)
audience: Platform admin (Daxx only)
server: Admin Server (admin/server.js)
status: built
---

# IRIS Map — S15: Admin Hub Dashboard

## Purpose
Daxx's cross-tenant management dashboard. Monitors all clients, error queues, webhooks, job queue, and member sync operations across all tenants. Accessed via browser, not via Wix iframe.

## Layout
Single-page application shell (index.html). Left sidebar navigation (6 tabs) + main content panel + slide-out drawer + confirm modal + toast container.

## Elements

### Shell (Persistent)
| Element | Type | Content |
|---------|------|---------|
| Sidebar | Left panel | 6 nav tabs + admin identity |
| Main panel | Right content area | Tab-specific content |
| Slide-out drawer | Overlay | Member timeline / error detail / webhook payload |
| Confirm modal | Modal | Destructive action confirmations |
| Toast container | Fixed overlay | Success/error notifications |
| Session expired modal | Modal | "Session expired — sign in again" (role-aware, from operator-nav.js) |

### Tab 1 — Error Queue
| Element | Type | Content |
|---------|------|---------|
| Error count badge | Badge (red) | Total errors across all clients |
| Client filter | Select | Filter by client |
| Error cards | Cards | All error_queue rows: client, member, event_type, error_reason, plan_name, door_name |
| Dismiss button | Button | Marks resolved + dismiss_note |
| View error detail button | Icon | Opens slide-out with full payload |
| Retry button | Button | Re-queues job |

### Tab 2 — Debug Center
| Element | Type | Content |
|---------|------|---------|
| Member search | Input | `doMemberSearch()` — lookup by platform_member_id |
| Member detail | Card | member_identity + member_access_state + role_assignments |
| Manual sync trigger | Button | Force re-queue for specific member |
| Client selector | Select | Scope search to specific client |

### Tab 3 — Webhook Inspector
| Element | Type | Content |
|---------|------|---------|
| Webhook log table | Table | webhook_log rows: event_id, client, received_at, hmac_status, dedup_status, event_type |
| HMAC status filter | Tag filter | accepted / rejected |
| Payload viewer | Slide-out drawer | `openWebhookDetail()` → raw_payload + normalized_payload |
| Client filter | Select | Filter by client |

### Tab 4 — Queue Monitor
| Element | Type | Content |
|---------|------|---------|
| BullMQ job list | Table | Active / waiting / failed jobs |
| Job detail | Expandable row | Job data, attempts, last error |
| Concurrency indicator | Label | Current worker concurrency |

### Tab 5 — Clients
| Element | Type | Content |
|---------|------|---------|
| Client list | Table/cards | All clients: name, site_id, status, tier, last_wix_webhook_at |
| Webhook health pill | Pill | LIVE / WARN / ERROR per client |
| Archive client | Button | `archiveClient()` — confirms + archives |
| Delete client | Button | `deleteClient()` — hard delete (destructive, confirm required) |
| Load clients button | Button | `loadClients()` — refreshes list |

### Tab 6 — Member Sync
| Element | Type | Content |
|---------|------|---------|
| Client selector | Select | Which client to operate on |
| Sync trigger | Button | Manual full sync for selected client |
| Sync status | Label | Last sync timestamp + result |

## Key Functions (from GRAPH_REPORT.md god nodes)
- `apiFetch()` — all API calls, 401 → session expired modal
- `loadClients()` — Tab 5 client list refresh
- `openErrorDetail()` → calls `apiFetch()` → slide-out drawer (cross-community bridge)
- `openWebhookDetail()` — webhook payload slide-out
- `openMemberTimeline()` — member timeline slide-out
- `archiveClient()`, `deleteClient()` — destructive client actions
- `doMemberSearch()` — Debug Center search

## States

| State | Trigger | Display |
|-------|---------|---------|
| Tab active | Sidebar click | Tab content loaded via apiFetch |
| Error count > 0 | error_queue non-empty | Red badge on Error Queue tab |
| Session expired | 401 response | Session expired modal (all tabs) |
| Destructive confirm | Archive/delete clicked | Confirm modal before action |
| Drawer open | Error detail / webhook / timeline | Slide-out from right |

## Navigation
- No external navigation (single-page app)
- Drawer: slide-out overlay
- Tabs: client-side routing (no full page reloads)

## Data Contracts (Sampling)

| Action | Endpoint | Method |
|--------|----------|--------|
| Load all clients | `GET /admin/clients` | GET |
| Archive client | `PATCH /admin/clients/:id/archive` | PATCH |
| Delete client | `DELETE /admin/clients/:id` | DELETE |
| Search member | `GET /admin/members/search?q=X` | GET |
| Load error queue | `GET /admin/errors?clientId=Y` | GET |
| Dismiss error | `PATCH /admin/errors/:id/dismiss` | PATCH |
| Load webhook log | `GET /admin/webhooks?clientId=Y` | GET |
