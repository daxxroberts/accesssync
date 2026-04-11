---
screen_id: S02
screen_name: Onboarding Flow
file: admin/views/pages/onboard.ejs
route: /onboard
method: GET
auth: Invite token (query param) OR Operator JWT
data_required: clientId, client record, locations
role: operator (new setup)
status: built
---

# IRIS Map — S02: Onboarding Flow

## Purpose
Multi-step wizard guiding a new operator through initial AccessSync configuration. Covers hardware platform selection, API key entry, location setup, and plan mapping. Entry point for first-time setup after S01.

## Layout
Full-page with topbar (AccessSync logo, step indicator). Step-by-step wizard — one section at a time. Not tabbed.

## Steps / Sections

| Step | Section | Key Elements |
|------|---------|--------------|
| 1 | Hardware Platform | Platform selector (Kisi / Seam radio or dropdown) |
| 2 | API Key Entry | Text input for hardware API key, "Test Connection" button, result indicator |
| 3 | Location Setup | Location name, city, state fields. Submit creates location row. |
| 4 | Plan Mapping | Wix plans listed, door/group dropdown per plan. Map + save. |
| 5 | Confirmation | Success state — "You're all set" + link to dashboard |

## Elements (All Steps)

| Element | Type | Content | Notes |
|---------|------|---------|-------|
| Step progress indicator | Top bar | "Step X of 5" or visual dots | Shows current position |
| Back button | Button (secondary) | "Back" | Returns to previous step |
| Continue/Save button | Button (primary) | "Continue" or "Save & Continue" | Advances step |
| Platform selector | Radio/Select | "Kisi" / "Seam" | Step 1 only |
| API key input | Input (password) | Hardware API key | Step 2. Label currently says "Kisi API Key" — U-09 fix required |
| Test Connection button | Button | "Test Connection" | Calls `POST /operator/:clientId/test-api-key`. Shows PASS/FAIL inline |
| Location name input | Input (text) | "Location name" | Step 3 |
| City / State inputs | Input (text) | City, State | Step 3 |
| Plan card list | Cards | One per Wix plan (from Wix API) | Step 4 |
| Door/group dropdown | Select | Kisi/Seam groups (from hardware API) | Step 4, per plan card |
| Success heading | H1 | "You're all set!" | Step 5 |
| Dashboard link | Button/link | "Go to Dashboard" | Step 5 → S03 |

## States

| State | Trigger | Display |
|-------|---------|---------|
| Default | Step loads | Form inputs empty or pre-filled if returning |
| API key test — pass | Test API returns success | Green indicator, "Connection successful" |
| API key test — fail | Test API returns error | Red indicator, error message inline |
| No Wix plans found | Wix API returns empty | "No pricing plans found" notice in step 4 |
| Plan mapping saved | Save success | Plan card updates to show door assignment |
| Submit error | Any step save fails | Inline error message under form |

## Navigation
- Entry: from S01 "Start Setup" or from direct `/onboard?clientId=X` link
- Step 5 (completion) → S03 Dashboard Overview
- Back button: previous step (no data loss)
- Session expiry: modal → login re-entry (operator-nav.js)

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load Wix plans | `GET /operator/:clientId/wix-plans` | GET |
| Load hardware groups | `GET /operator/:clientId/kisi-groups` | GET |
| Test API key | `POST /operator/:clientId/test-api-key` | POST |
| Save API key | `PATCH /operator/:clientId/api-key` | PATCH |
| Create location | `POST /operator/:clientId/locations` | POST |
| Save plan mapping | `PATCH /operator/:clientId/plan-mappings/:id` | PATCH |

## Known Gaps / Issues
- Step 2 API key input label says "Kisi API Key" — **U-09 fix required pre-HOG**. Should say "Hardware API Key" or "Access Control API Key".
- No explicit handling for operator who already has an API key returning to onboard (re-entry path unclear — FUNNEL-G-15 partial).
- Step 4 plan card duplicate-group warning present in plan-mapping.ejs — verify same warning exists in onboard step 4.
