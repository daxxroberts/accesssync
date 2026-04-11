---
screen_id: S01
screen_name: Portal Setup Welcome
file: admin/views/pages/portal-setup.ejs
route: /operator-portal/setup
method: GET
auth: Operator JWT (sameSite: none, 8h)
data_required: clientId (from JWT)
role: operator (first-run only)
status: built
---

# IRIS Map — S01: Portal Setup Welcome

## Purpose
First screen a new operator sees after Wix Dashboard sidebar loads AccessSync iframe. Static welcome card — no data fetched, no form. Gates entry to the onboarding flow.

## Layout
Single centered card. No navigation bar. No subnav.

## Elements

| Element | Type | Content | Notes |
|---------|------|---------|-------|
| AccessSync logo | Image/text | "AccessSync" wordmark | Top of card |
| Welcome heading | H1 | "Welcome to AccessSync" | Primary message |
| Time estimate | Body text | "5 minutes to set up" | Reassurance copy |
| Benefit bullets | List | 3 setup steps or benefits | Static copy |
| Start Setup CTA | Button (primary) | "Start Setup" | Links to `/onboard?clientId=<clientId>` |

## States

| State | Trigger | Display |
|-------|---------|---------|
| Default | Any first-run operator | Welcome card shown |
| No clientId | JWT decode failed | Error state (not explicitly designed — gap) |

## Navigation
- CTA → S02 Onboarding Flow (`/onboard?clientId=<clientId>`)
- No back navigation (entry point)

## Data Contracts
- No API calls on load
- `clientId` passed from portal.js JWT decode → embedded in CTA link

## Known Gaps
- No explicit error state if `clientId` missing from JWT decode
- Static copy — not personalized with gym name yet
