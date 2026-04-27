# Member Hub — Design Brief
# For Claude Design (browser session)
# Produced by QUILL · AccessSync BOT Team · 2026-04-26

---

## What You Are Building

A single self-contained HTML page (`member-hub.ejs`) that replaces three separate member-facing iframes with one. A gym member opens one Wix page, one iframe loads, and they see a tabbed interface covering all their membership interactions.

**Output file:** `admin/views/pages/member-hub.ejs`  
**Route:** `GET /member-hub?memberId=X&clientId=Y`  
**Replaces (but does not delete):** `sync-status.ejs`, `my-access.ejs`, `multi-member.ejs`

---

## Repo Files to Read

Read these files directly — they are the source of truth for content, logic, and style:

| File | What it gives you |
|------|------------------|
| `admin/views/pages/my-access.ejs` | Tab 1 content — full HTML + JS |
| `admin/views/pages/sync-status.ejs` | Status overlay content — full HTML + JS |
| `admin/views/pages/multi-member.ejs` | Tab 2 content — full HTML + JS |
| `MULTI_MEMBER_WIDGET_CONTEXT.md` | Backend contracts for the multi-member tab |
| `admin/views/partials/head.ejs` | Shared head partial (font, CSS link) |

---

## Theme

**Light theme throughout.** Use the LIGHT palette from `multi-member.ejs` — it is the current design direction for member-facing pages. Do not use the dark palette from `sync-status.ejs`.

```css
:root {
  --brand:       #4F6EF7;
  --brand-dark:  #3D5BD4;
  --brand-dim:   rgba(79,110,247,0.10);
  --brand-glow:  rgba(79,110,247,0.20);
  --green:       #16A34A;
  --green-dim:   rgba(22,163,74,0.10);
  --green-glow:  rgba(22,163,74,0.25);
  --amber:       #D97706;
  --amber-dim:   rgba(217,119,6,0.10);
  --red:         #DC2626;
  --red-dim:     rgba(220,38,38,0.07);
  --bg:          #FAFAF7;
  --card:        #FFFFFF;
  --card2:       #F5F4F0;
  --border:      rgba(28,22,16,0.06);
  --border2:     rgba(28,22,16,0.10);
  --text:        #1F1B16;
  --text2:       #6E6358;
  --muted:       #9A8F82;
}
```

Font: **Sora** (Google Fonts, weights 300–800)

---

## Tab Architecture

### Permanent Tabs (always visible in the tab bar)

| # | Tab label | Source page | Default |
|---|-----------|-------------|---------|
| 1 | My Access | `my-access.ejs` | ✅ Yes |
| 2 | Manage Members | `multi-member.ejs` | No — hidden until `allowMultiple` confirmed |

### Transient Status Overlay (not a tab — fully embedded, always present in the shell)

The **Access Status** screen is NOT a visible tab. It has no tab bar entry. But its full implementation — animated icon, 4-step pipeline, polling logic, all states — lives inside the shell permanently. It is always there, just hidden until triggered.

**Why it's included even though it's hidden:** The goal is one iframe object for every Wix site. Drop in one HTML Component, get all three member interactions — access dashboard, sync confirmation, and member management. No separate pages to wire up.

**Triggers:**
- `?tab=status` in the URL (post-purchase redirect from Wix Thank You page), OR
- Member's access status is actively syncing (`in_flight` / `pending_sync`) on load

**Behavior:**
- When triggered, it covers the full content area (tab bar hidden or dimmed behind it)
- Polls `/member/access-status` every 3s, max 60 polls
- Once resolved to `active` or `error`, shows resolved state for ~1.5s then auto-dismisses to My Access tab
- Member never manually closes it — it dismisses itself
- Polling pauses when overlay is not visible, resumes when it is

This mirrors the Thank You page pattern already shipped — same concept, now embedded inside the hub so it's available on any Wix page that embeds this single object.

### Manage Members Tab — Visibility Gate

- On load, fetch `GET /member/{memberId}/widget-data?clientId={clientId}`
- If any plan has `allowMultiple: true` → show the Manage Members tab
- If no plan has `allowMultiple: true` → hide the tab entirely (do not show a disabled/grayed tab)
- The tab appearing and then disappearing is bad UX — gate it before first render

---

## URL Params

All passed as query string. Same params across all tabs — the shell owns them.

```
?memberId=<wix_member_id>
&clientId=<accesssync_client_uuid>
&tab=status   ← optional, triggers Status overlay on load
```

---

## iframe Resize

After every tab switch and every content height change, the shell must call:

```js
window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*');
```

This is how the Wix iframe resizes to fit the content. Every existing page already does this — preserve the pattern.

---

## Wix Embed (one Velo file, replaces three)

The Velo page code at `handoff/velo/multi-member-page.js` will be updated to point to `/member-hub` instead of `/multi-member`. One HTML Component, one `onMessage` resize listener, one URL.

The post-purchase Thank You page Velo code passes `?tab=status` in the URL so the Status overlay fires immediately on load.

---

## What the Three Content Sections Contain

### Tab 1 — My Access (`my-access.ejs`)
- Status banner (active / syncing / error / pending / revoked)
- Your Plans card — list of active Wix plans
- Door Access card — list of provisioned doors from AccessSync
- Last synced timestamp + Check Status button
- Skeleton loaders on first load
- Data: `GET /member/access-status?platformMemberId=X&clientId=Y`

### Status Overlay (`sync-status.ejs`)
- Animated icon (syncing spinner, checkmark, error)
- 4-step pipeline animation (Order received → Account located → Access rules applied → Door access granted)
- Polls until resolved, then auto-dismisses to My Access tab
- Data: same `GET /member/access-status` endpoint

### Tab 2 — Manage Members (`multi-member.ejs`)
- Hero card with ring progress (X of Y spots used)
- Sub-member list with status badges (draft / active / pending / failed)
- Add member form (modal pattern)
- Edit / remove per member
- Submit drafts CTA
- allowMultiple gate (tab hidden if no plan qualifies)
- Data: 5 endpoints — see `MULTI_MEMBER_WIDGET_CONTEXT.md` for full contracts

---

## Behavioral Rules (from FAULT review)

1. **Manage Members tab must not flash** — determine visibility from widget-data response before rendering the tab bar. Don't show it and then hide it.

2. **Status polling pauses off-screen** — when the Status overlay is not active, polling stops. When it becomes active again, polling resumes. Do not poll in the background.

3. **Status overlay auto-dismisses** — member never manually closes it. On resolution (`active` or `error`), show the resolved state for ~1.5s then slide/fade to My Access tab.

4. **Tab state persists on resize** — `notifyHeight()` on every tab switch so the iframe never clips content.

5. **All three tabs share the same memberId + clientId** — parsed once at the shell level, passed down to each tab's data-fetching functions.

---

## What You Are NOT Building

- No operator-facing UI — this is member-facing only
- No authentication — memberId + clientId are trusted URL params
- No navigation outside the hub — no links to other pages
- Do not rewrite the existing three EJS files — the hub is a new fourth file
- Do not use the dark palette from sync-status.ejs — light theme only

---

## Deliverable

A single self-contained `member-hub.ejs` file:
- No external JS dependencies (no React, no framework)
- Sora font from Google Fonts CDN
- All CSS inline in `<style>`
- All JS inline in `<script>`
- EJS front matter comment block at the top (follow the pattern in the existing pages)
- Works as a standalone HTML file for design review (mock data OK for design phase)
- Production wiring (real API calls) happens in VS Code after design is approved
