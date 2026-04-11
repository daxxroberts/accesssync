---
screen_id: S14
screen_name: Admin Hub Login
file: admin/public/index.html (login section)
route: /admin/login (or root redirect)
method: GET / POST
auth: None (login screen)
audience: Platform admin (Daxx only)
server: Admin Server (admin/server.js)
status: built
---

# IRIS Map — S14: Admin Hub Login

## Purpose
Authentication screen for platform admin (Daxx) to access the Admin Hub. Separate from the operator portal — this is Daxx's dashboard for managing all tenants.

## Layout
Centered login card. No topbar (pre-auth). Plain background.

## Elements

| Element | Type | Content |
|---------|------|---------|
| Logo/wordmark | Image/text | AccessSync |
| "Admin Hub" label | Subtext | Below logo |
| Google Sign-In button | OAuth button | "Sign in with Google" → `handleGoogleCredential()` |
| Error message | Inline text (red) | On auth failure |

## Auth Flow
1. Admin clicks "Sign in with Google"
2. Google credential returned → `handleGoogleCredential()` in app.js
3. Credential POSTed to `/admin/auth/google`
4. Server validates against allowed admin emails
5. Admin session JWT issued
6. Redirect → S15 Admin Hub Dashboard

## States

| State | Trigger | Display |
|-------|---------|---------|
| Default | Page load | Login card, Google button |
| Auth error | Invalid credential or unauthorized email | Inline error message |
| Auth success | Valid admin | Redirect to S15 |

## Navigation
- No navigation (pre-auth)
- Success → S15 Admin Hub Dashboard

## Data Contracts

| Action | Endpoint | Method |
|--------|----------|--------|
| Google auth | `POST /admin/auth/google` | POST |
