---
screen_id: S13
screen_name: Sync Status Widget (Member-Facing)
file: admin/views/pages/sync-status.ejs (member audience — same file as S09 but different data path)
route: /sync-status?memberId=X&clientId=Y
method: GET
auth: None (link from Wix post-purchase confirmation) OR member JWT for Wix widget
audience: gym members (post-purchase)
server: Core Engine (core/server.js) → GET /member/access-status
status: built
---

# IRIS Map — S13: Sync Status Widget (Member-Facing)

## Purpose
Post-purchase confirmation screen shown to gym members after buying a plan or booking a class. Confirms that AccessSync received their purchase and is provisioning their access. Auto-polls until active or error. Mobile-first design.

## Layout
Centered card on plain background. No navigation. No topbar (standalone page, not embedded in operator portal). Full-height centered.

## Elements

### Status Card
| Element | Type | Content |
|---------|------|---------|
| Status icon | Large circle icon | Animated for syncing, static for resolved states |
| Status heading | H2 | State-specific: see states below |
| Status subtext | Body | State-specific explanation |
| Stale indicator | Subtext (amber) | "Still syncing… this is taking longer than usual" (shown after 30s) |

### Status States and Copy

| State | Icon | Heading | Subtext | Trigger |
|-------|------|---------|---------|---------|
| syncing | Animated spinner (brand) | "Setting up your access…" | "This usually takes a few seconds." | status = pending_sync / in_flight |
| active | Checkmark (green) | "You're all set!" | "Your access has been activated. You can now use the [gym] app to get in." | status = active |
| error | X icon (red) | "Something went wrong" | "Please contact [gym name] for help." | status = failed |
| pending | Clock icon (amber) | "Almost there…" | "The gym is still setting up. You'll get access once setup is complete." | status = pending_hardware |

### Polling Behavior
| Parameter | Value |
|-----------|-------|
| Poll interval | Every 3 seconds |
| Max polls | 60 (= 3 minutes max) |
| Stale threshold | 30 seconds |
| Timeout state | Shows error state after 60 polls with no resolution |

## Data Contracts

| Action | Endpoint | Returns |
|--------|----------|---------|
| Poll member status | `GET /member/access-status?memberId=X&clientId=Y` | status, hardware_platform, role_assignments, log entries |

**Auth path:** URL param memberId + clientId for Wix post-purchase link. Member JWT (RS256 via Wix public keys) for widget embed. JWT payload `uid` = Wix member ID = `platform_member_id`.

## Navigation
- No navigation (standalone confirmation screen)
- After active state: no CTA (member is done)
- After error state: no retry — contact gym

## Known Gaps / Issues
- **U-09:** Screen currently says "Kisi app" hardcoded in the active state subtext. Must be replaced with platform-agnostic copy ("gym app" or dynamic platform name) before HOG.
- Polling is client-side only — no server-push. If member closes tab, they don't get a notification when access is ready.
