---
screen_id: S04
screen_name: System Config
file: admin/views/pages/onboard.ejs (config sections reused)
route: /system-config (or config tab within dashboard)
method: GET
auth: Operator JWT
data_required: clientId, client record
role: operator
status: built
---

# IRIS Map — S04: System Config

## Purpose
Operator configuration for org-level settings: hardware platform, API key, Wix API key, and notification email. These are client-level settings — location-level overrides live in S05.

## Layout
Tabbed within operator dashboard. Uses same topbar/subnav as all operator screens. Content in form cards.

## Elements

### Hardware Platform Section
| Element | Type | Content |
|---------|------|---------|
| Platform selector | Select/radio | "Kisi" / "Seam" |
| Current platform display | Label | Shows currently saved platform |
| Save button | Button (primary) | Saves `clients.hardware_platform` |

### Hardware API Key Section
| Element | Type | Content |
|---------|------|---------|
| API key input | Input (password) | Masked. Placeholder: "Enter API Key" |
| Input label | Label | Currently "Kisi API Key" — **U-09 pre-HOG fix: change to "Hardware API Key"** |
| Test Connection button | Button | Calls `POST /operator/:clientId/test-api-key`. Shows PASS/FAIL inline |
| Last verified timestamp | Subtext | `locations.hardware_key_last_verified` (or client-level equivalent) |
| Save button | Button (primary) | Saves encrypted API key |

### Wix API Key Section
| Element | Type | Content |
|---------|------|---------|
| Wix API key input | Input (password) | Masked |
| Help text | Subtext | Explains what the Wix API key is used for (outbound plan/booking lookups) |
| Save button | Button (primary) | Saves encrypted `clients.wix_api_key` |

### Notification Email Section
| Element | Type | Content |
|---------|------|---------|
| Email input | Input (email) | `clients.notification_email` |
| Help text | Subtext | "Alert emails go here (key failures, HMAC spikes)" |
| Save button | Button (primary) | Saves email |

## States

| State | Trigger | Display |
|-------|---------|---------|
| No API key saved | New operator | Input empty, no "last verified" |
| API key saved | Key exists | Input shows masked value (●●●●●) |
| Test pass | API returns success | Green inline confirmation |
| Test fail | API returns error | Red inline error with detail |
| Save success | PATCH succeeds | Toast: "Settings saved" |
| Save fail | PATCH fails | Inline error |

## Navigation
- Subnav: tab within operator dashboard
- Saving API key → triggers pending_hardware resolution for this client (WIRE-G-01 — not yet built)

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load client config | `GET /operator/:clientId` | GET |
| Save hardware platform | `PATCH /operator/:clientId/hardware-platform` | PATCH |
| Save API key | `PATCH /operator/:clientId/api-key` | PATCH |
| Test API key | `POST /operator/:clientId/test-api-key` | POST |
| Save Wix API key | `PATCH /operator/:clientId/wix-api-key` | PATCH |
| Save notification email | `PATCH /operator/:clientId/notification-email` | PATCH |

## Known Gaps
- **U-09:** API key input label says "Kisi API Key" — must say "Hardware API Key" before HOG
- **WIRE-G-01:** Saving API key does not yet trigger pending_hardware re-queue
- **SCREEN-G-02:** API key form label platform-agnostic fix (same as U-09)
