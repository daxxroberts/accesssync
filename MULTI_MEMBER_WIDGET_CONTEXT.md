# Multi-Member Widget — Full Design Context
# Pass this entire file to the AI building the frontend.

---

## WHAT YOU ARE BUILDING

A member-facing iframe page (`multi-member-widget.html` or `.ejs`) that a plan holder (primary gym member) uses to:
1. See their current additional members and their access status
2. Add new additional members (enter name, email, phone)
3. Edit draft members before submitting
4. Remove a member (draft = immediate; active = queues hardware revoke)
5. Submit all drafts at once to trigger provisioning

This page is embedded as a Wix iframe on the gym's Wix site. The plan holder is already logged into Wix when they see it. The page is self-contained HTML/CSS/JS — no framework, no build step.

---

## BRANDING & TYPOGRAPHY

### Font
```
Sora (Google Fonts)
Weights used: 300, 400, 500, 600, 700, 800
URL: https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap
font-family: 'Sora', sans-serif;
-webkit-font-smoothing: antialiased;
```

### CSS Variables (dark mode — matches sync-status.ejs member-facing style)
```css
:root {
  --brand:       #4F6EF7;
  --brand-dark:  #3D5BD4;
  --brand-dim:   rgba(79,110,247,0.11);
  --brand-glow:  rgba(79,110,247,0.18);

  --green:       #22C55E;
  --green-dim:   rgba(34,197,94,0.12);
  --green-glow:  rgba(34,197,94,0.25);

  --amber:       #F59E0B;
  --amber-dim:   rgba(245,158,11,0.12);

  --red:         #EF4444;
  --red-dim:     rgba(239,68,68,0.10);

  /* Dark background (member-facing pages always dark) */
  --bg:          #0B0F1A;
  --card:        #131929;
  --card2:       #1A2236;
  --border:      rgba(255,255,255,0.07);
  --border2:     rgba(255,255,255,0.12);
  --text:        #F1F5F9;
  --text2:       #94A3B8;
  --muted:       #475569;
}
```

### Logo mark (SVG)
```html
<div class="logo-mark" style="width:26px;height:26px;background:#4F6EF7;border-radius:7px;display:flex;align-items:center;justify-content:center;">
  <svg viewBox="0 0 20 20" fill="none" style="width:14px;height:14px;">
    <path d="M10 3L3 7v6l7 4 7-4V7L10 3z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" fill="white"/>
  </svg>
</div>
```

### Status badge colors
- `active` → green (#22C55E), background rgba(34,197,94,0.12)
- `draft` → amber (#F59E0B), background rgba(245,158,11,0.12)
- `pending_sync` / `submitted` / `in_flight` → brand (#4F6EF7), background rgba(79,110,247,0.11)
- `failed` / `error` → red (#EF4444), background rgba(239,68,68,0.10)

---

## API CONTRACTS

### Base URL
The widget receives `CORE_URL` and `CLIENT_ID` as URL params (injected by Wix Velo at iframe render time):
```
?memberId=<wix_member_id>&clientId=<accesssync_client_uuid>&coreUrl=<railway_url>
```

### 1. Load widget data
```
GET {CORE_URL}/member/{memberId}/widget-data?clientId={clientId}

Response 200:
{
  holder: {
    id: UUID,
    platformMemberId: string,
    accessStatus: "active" | "in_flight" | "failed" | "pending_sync" | null,
    provisionedAt: ISO-8601 | null
  },
  plans: [
    {
      id: UUID,
      sourcePlanId: string,
      planName: string,
      allowMultiple: boolean,
      maxMembers: integer,
      doorName: string
    }
  ],
  subMembers: [
    {
      id: UUID,
      platformMemberId: string,
      firstName: string,
      lastName: string,
      email: string,
      phone: string,
      status: "draft" | "submitted" | null,
      accessStatus: "active" | "in_flight" | "failed" | "pending_sync" | null,
      provisionedAt: ISO-8601 | null
    }
  ]
}

Response 404: { error: "Member not found" }
```

### 2. Add a sub-member (draft)
```
POST {CORE_URL}/api/multi-member/members
Content-Type: application/json

Body:
{
  holderId: UUID,       // holder.id from widget-data
  clientId: UUID,
  firstName: string,
  lastName: string,
  email: string,
  phone: string
}

Response 201:
{
  ok: true,
  subMember: { id, platformMemberId, firstName, lastName, email, phone, status: "draft" }
}

Response 409: { error: "Maximum N additional members allowed" }
Response 400: { error: "All fields required: ..." }
```

### 3. Edit a draft sub-member
```
PUT {CORE_URL}/api/multi-member/members/{subMemberId}
Content-Type: application/json

Body: { firstName, lastName, email, phone }

Response 200: { ok: true, subMember: { id, firstName, lastName, email, phone } }
Response 404: { error: "Draft sub-member not found (only draft members can be edited)" }
```

### 4. Remove a sub-member
```
DELETE {CORE_URL}/api/multi-member/members/{subMemberId}

Response 200: { ok: true, message: "Draft member removed" | "Member removed and access revoked" }
Response 404: { error: "Sub-member not found" }
```

### 5. Submit all drafts for provisioning
```
POST {CORE_URL}/api/multi-member/submit
Content-Type: application/json

Body: { holderId: UUID, clientId: UUID }

Response 200:
{
  ok: true,
  submitted: integer,
  members: [{ id, platformMemberId, firstName, lastName, email }]
}

Response 400: { error: "No draft members to submit" }
```

---

## DATA MODEL (what the DB looks like)

### member_identity
Primary members: `plan_holder_id IS NULL`
Sub-members: `plan_holder_id = <primary member UUID>`
Sub-member platform ID format (DR-029): `{holderPlatformId}###as001`, `###as002`, etc.

Columns relevant to UI:
- `first_name`, `last_name`, `email`, `phone` — stored for sub-members
- `sub_member_status`: `'draft'` | `'submitted'` | `NULL` (primary)
- `created_at`, `updated_at`

### member_access_state
- `status`: `pending_sync` | `in_flight` | `active` | `disabled` | `revoked` | `failed` | `pending_hardware` | `pending_identity` | `pending_start` | `suspended`
- `provisioned_at`: timestamp when hardware access was confirmed

### plan_mappings
- `allow_multiple`: boolean — only show multi-member UI when this is true
- `max_members`: integer — hard limit on sub-members per holder

### Lifecycle: Draft → Submit → Active
1. Plan holder adds members → stored as `sub_member_status = 'draft'`
2. Plan holder clicks Submit → all drafts set to `'submitted'`; `member_access_state.status = 'pending_sync'`; BullMQ grant jobs enqueued
3. Jobs run → `member_access_state.status = 'active'`; `provisioned_at` set

---

## UX BEHAVIOUR RULES

### Plan availability
- Only show the multi-member UI if `plans.length > 0` AND at least one plan has `allowMultiple = true`
- If no plans allow multiple members, show a message: "Your current plan doesn't include additional members."

### Member limit
- The add button should be disabled (and show remaining count) when `subMembers.length >= maxMembers`
- Use the lowest `maxMembers` across all plans if multiple plans exist
- Show remaining: "2 of 3 spots used"

### Draft vs. submitted vs. active
- **Draft** members: show edit (pencil) + remove (trash) icons. Not yet provisioned.
- **Submitted / in_flight / pending_sync** members: show spinner/badge, no edit. Remove is allowed (queues revoke).
- **Active** members: show green "Active" badge + provisioned time. Remove is allowed (queues revoke).
- **Failed** members: show red "Failed" badge. Remove is allowed. Consider showing a retry note.

### Submit button
- Only visible when there are draft members
- Label: "Grant access to N member{s}" where N = count of drafts
- After submit: clear draft state, show all members as "Pending sync", optimistically update UI

### Remove confirmation
- Draft: no confirmation needed — just remove
- Active/submitted: show a simple inline confirmation: "Remove [Name]? Their access will be revoked." with Cancel / Remove buttons

### Form validation (client-side before POST)
- `firstName`: non-empty, trim whitespace
- `lastName`: non-empty, trim whitespace
- `email`: basic regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- `phone`: min 7 characters after trim

### Error handling
- 409 on add → show toast: "Member limit reached — this plan allows up to N additional members."
- 400 → show toast with the error message from the API
- Network error → show toast: "Something went wrong. Try again."
- 404 on load → show error state: "We couldn't find your membership. Contact your gym."

### Iframe sizing
- The page renders inside a Wix iframe. Use `min-height: 100vh` on the body but also post a height message to the parent after render so Wix can resize the iframe:
```js
function notifyHeight() {
  const h = document.body.scrollHeight;
  window.parent.postMessage({ type: 'resize', height: h }, '*');
}
// call after every state change that changes height
```

---

## PAGE STRUCTURE (recommended)

```
┌─────────────────────────────────┐
│  Logo lockup (faint, top)       │
├─────────────────────────────────┤
│  Section: Your Plan             │
│  Plan name + door + max slots   │
│  "2 of 3 spots used"            │
├─────────────────────────────────┤
│  Section: Additional Members    │
│  Member row × N                 │
│    [Avatar initials] Name       │
│    email · phone                │
│    [status badge]  [edit][del]  │
│                                 │
│  [+ Add Member] button          │
├─────────────────────────────────┤
│  [Grant access to N members]    │  ← only when drafts exist
│  (submit CTA, full width)       │
└─────────────────────────────────┘
```

### Add/Edit form (inline slide-down or modal)
```
First name  [________________]
Last name   [________________]
Email       [________________]
Phone       [________________]
            [Cancel]  [Add member]
```

---

## ANIMATION PATTERNS (from sync-status.ejs)

Reuse these animation keyframes:

```css
/* Pulse on active/syncing status dots */
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

/* Fade-up for list items appearing */
@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Background orbs (subtle, optional) */
@keyframes orb-drift-1 { from{transform:translate(0,0)} to{transform:translate(60px,40px)} }
@keyframes orb-drift-2 { from{transform:translate(0,0)} to{transform:translate(-40px,-60px)} }

/* Spinner for pending states */
@keyframes spin { to { transform: rotate(360deg); } }
```

### Pulse ring for syncing members
```css
@keyframes pulse-ring {
  0%   { transform: scale(1);    opacity: 0.5; }
  70%  { transform: scale(1.55); opacity: 0; }
  100% { transform: scale(1.55); opacity: 0; }
}
```

---

## TOAST PATTERN

```js
function showToast(message, type = 'info') {
  // type: 'success' | 'error' | 'info'
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} visible`;
  setTimeout(() => toast.classList.remove('visible'), 3500);
}
```

```css
.toast {
  position: fixed; bottom: -60px; left: 50%; transform: translateX(-50%);
  background: #1A2236; color: #F1F5F9; padding: 12px 20px;
  border-radius: 10px; font-size: 13px; font-weight: 600;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  z-index: 800; transition: transform 0.3s ease;
}
.toast.visible  { transform: translateX(-50%) translateY(-80px); }
.toast.success  { border-left: 4px solid #22C55E; }
.toast.error    { border-left: 4px solid #EF4444; }
.toast.info     { border-left: 4px solid #4F6EF7; }
```

---

## FULL BACKEND CODE REFERENCE

### multi-member.js (admin/routes/multi-member.js)
```javascript
// GET /member/:memberId/widget-data
// Returns holder, plans[], subMembers[]
// - holder: { id, platformMemberId, accessStatus, provisionedAt }
// - plans filtered by allow_multiple = true
// - subMembers ordered by created_at

// POST /api/multi-member/members
// Validates: holderId, clientId, firstName, lastName, email, phone all required
// Checks max_members limit (COALESCE MAX across all allow_multiple mappings)
// Generates sub-member platformMemberId: {holderPlatformId}###as{NNN}
// Inserts with sub_member_status = 'draft'

// PUT /api/multi-member/members/:subId
// Only updates if sub_member_status = 'draft'
// Returns 404 if submitted/active

// DELETE /api/multi-member/members/:subId
// Draft → immediate DELETE from member_identity
// Active → enqueue BullMQ revoke job first, then DELETE

// POST /api/multi-member/submit
// Updates all drafts to 'submitted'
// INSERTs member_access_state rows with status='pending_sync'
// Enqueues one BullMQ 'grant' job per sub-member (synthetic plan.purchased event)
// planId pulled from first active allow_multiple mapping for this client
```

### member-sync-api.js — getAccessStatus
```javascript
// GET /member/access-status?platformMemberId=X&clientId=Y
// Auth: RS256 JWT from Wix (OB-08) — uid in JWT must match platformMemberId
// Returns:
//   status: 'active' | 'in_flight' | 'failed' | 'pending_sync' | 'pending_start' | 'suspended' | null
//   provisionedAt: timestamp | null
//   scheduledStartDate: ISO-8601 | null
//   lastEvent: { eventType, credentialType, errorCode, createdAt } | null
//   access: [{ planName, doorName, locationName, groupId }]
```

### schema — multi-member columns
```sql
-- member_identity additions (multi-member.sql):
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS plan_holder_id UUID REFERENCES member_identity(id) ON DELETE CASCADE;
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE member_identity ADD COLUMN IF NOT EXISTS sub_member_status VARCHAR(50);
-- Values: 'draft' | 'submitted' | NULL (primary member)

-- member_access_state additions:
ALTER TABLE member_access_state ADD COLUMN IF NOT EXISTS plan_holder_id UUID REFERENCES member_identity(id) ON DELETE CASCADE;

-- plan_mappings additions:
ALTER TABLE plan_mappings ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT false;
ALTER TABLE plan_mappings ADD COLUMN IF NOT EXISTS max_members INTEGER DEFAULT 1;
```

---

## SYNC-STATUS PAGE PATTERNS TO REUSE

The `sync-status.ejs` page is the UX reference for member-facing pages. Key patterns:

### Background orbs
```html
<div class="bg-orb bg-orb-1"></div>
<div class="bg-orb bg-orb-2"></div>
```
```css
.bg-orb { position:fixed; border-radius:50%; filter:blur(80px); pointer-events:none; z-index:0; }
.bg-orb-1 {
  width:min(500px,100vw); height:min(500px,100vw);
  background:radial-gradient(circle, rgba(79,110,247,0.12) 0%, transparent 70%);
  top:-120px; left:-120px;
  animation: orb-drift-1 18s ease-in-out infinite alternate;
}
.bg-orb-2 {
  width:min(400px,90vw); height:min(400px,90vw);
  background:radial-gradient(circle, rgba(34,197,94,0.07) 0%, transparent 70%);
  bottom:-100px; right:-80px;
  animation: orb-drift-2 22s ease-in-out infinite alternate;
}
```

### Card container
```css
.card {
  position: relative; z-index: 1;
  background: var(--card); border: 1px solid var(--border2); border-radius: 16px;
  padding: 32px 24px 28px; max-width: 480px; width: 100%;
  box-shadow: 0 0 0 1px var(--border), 0 24px 60px rgba(0,0,0,0.45), 0 0 80px rgba(79,110,247,0.04);
}
@media (min-width: 520px) { .card { padding: 44px 40px 40px; } }
```

### Access item card (for showing active doors — reuse for member status)
```css
.access-item {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px;
  background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.2);
  border-radius: 12px;
  animation: fade-up 0.4s ease forwards; opacity: 0;
}
```

### XSS-safe HTML output (always use this for user data)
```js
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

---

## OPEN ITEMS / DEFERRED DECISIONS

Per the vault (DR-029 through DR-032 are LOCKED and READY):
- **DR-029**: Sub-member ID format `{wix_uuid}###as{NNN}` — locked
- **DR-030**: `plan_holder_id` on `member_identity` and `member_access_state` — locked
- **DR-031**: Upstream explosion pattern — family events exploded in Layer 2. Core Engine unchanged — locked
- **DR-032**: Draft → Submit workflow — locked

The multi-member feature is gated on **HOG go-live** and **Chad confirming family/multi memberships are sold**. This context file is for designing the frontend — no code is deployed until the trigger fires.

**This page is deferred post-HOG-launch.** Build the design and HTML file. Do not wire routes or deploy until the gate is lifted.

---

## FILE OUTPUT TARGET

Output a single self-contained file:
`admin/views/pages/multi-member-widget.ejs`

Or if building as plain HTML first:
`admin/public/multi-member-widget.html`

The page must work as an iframe embed on a Wix site. No external JS dependencies. Sora font from Google Fonts is fine (it's already used on the sync-status page).
```
