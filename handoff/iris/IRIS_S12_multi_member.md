---
screen_id: S12
screen_name: Multi-Member Editor
file: admin/views/pages/multi-member.ejs
route: /multi-member
method: GET
auth: Operator JWT OR member JWT (member-facing sub-member management)
data_required: planHolderId, sub-member list
role: operator / member (plan holder)
status: built — GATED (deferred post-HOG, hard stop in CLAUDE.md)
---

# IRIS Map — S12: Multi-Member Editor

## Purpose
Allows a plan holder to add, view, and remove sub-members on a family/multi-member plan. Sub-members are additional people (e.g., family members) added by the plan holder — they have no Wix account and are managed entirely within AccessSync.

## GATE STATUS
**DEFERRED post-HOG.** Code is complete but gated. Do not activate without confirmation from Chad (HOG) that family plans are live. `allow_multiple` flag on plan_mappings must be true for this screen to surface.

## Layout
Fullscreen or modal-style form. List of existing sub-members + "Add Member" form.

## Elements

### Sub-Member List
| Element | Type | Content |
|---------|------|---------|
| Member row | List item | First name + last name + email + phone + status |
| Status pill | Pill | active / pending / draft |
| Remove button | Icon button (destructive) | Removes sub-member → triggers revoke |
| Empty state | Message | "No additional members yet. Add one below." |

### Add Sub-Member Form
| Element | Type | Content |
|---------|------|---------|
| First name | Input (text) | Required |
| Last name | Input (text) | Required |
| Email | Input (email) | Required (FP-01 — email required for hardware provisioning) |
| Phone | Input (tel) | Required |
| Submit button | Button (primary) | "Add Member" — creates draft record, triggers grant flow |
| Cancel button | Button (secondary) | Clears form |

## States

| State | Trigger | Display |
|-------|---------|---------|
| Draft | Sub-member created, not provisioned | Amber "Pending" pill |
| Submitted | Grant flow triggered | In-flight → active |
| Active | Provisioned in hardware | Sage "Active" pill |
| Remove confirm | Remove clicked | Confirmation dialog: "Remove [Name]? They will lose access." |
| Plan limit reached | Sub-members = max_members | "Add Member" button disabled, limit message |
| Gate active | allow_multiple = false | Screen not accessible |

## Navigation
- Entry: From member portal widget (plan holder clicks "Manage Members") OR operator view of a plan holder's member card
- After add: list updates, grant flow fires in background
- After remove: confirmation → revoke fires, member removed from list

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Load sub-members | `GET /member/sub-members/:planHolderId` | GET |
| Add sub-member | `POST /member/sub-members` | POST |
| Remove sub-member | `DELETE /member/sub-members/:subMemberId` | DELETE |

## Key Rules (DR-029 – DR-032)
- Sub-members get AccessSync-generated UUID as platform_member_id (no Wix account)
- Created in `draft` status, move to `submitted` on form submit
- Plan holder revoke → all sub-members revoked (DR-030 cascade)
- Sub-member failure does not affect plan holder's access (DR-031)
- max_members enforcement at submit time — reject if at limit
