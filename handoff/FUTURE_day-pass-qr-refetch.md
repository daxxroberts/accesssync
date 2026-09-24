# FUTURE BUILD — Day-pass QR: fetch or resend after the email

**Status:** PAUSED (Builder, 2026-09-24). OB number: **TBD** — KEEPER to assign and
mirror into vault `open_items.md`.
**Related:** OB-98 / OB-251 (day passes), `core/day-pass-api.js`, `core/SNIPPET_REGISTRY.json`.

## Problem

Today the day-pass QR reaches the buyer in one place only: the "Your House of Gains day
pass is ready" email. If they lose or can't find it, there is no self-serve way back to
the code, and staff at the door have no button to re-send it.

## What already exists (verified 2026-09-24)

- **Re-fetch works.** The QR is never stored. `hardwareAdapter.getGroupLink()`
  (Kisi `GET /group_links/:id`) returns the same link + QR on demand.
- **`POST /member/day-pass`** (`core/day-pass-api.js`) releases the QR only to a request
  HMAC-signed with the client's Wix webhook secret (i.e. the gym's own Velo backend).
  The image is served from a 10-minute signed URL (`GET /member/day-pass/qr.png?t=`).
- **Snippet `thank_you_day_pass`** (Setup → snippets) shows the QR on the Wix Thank You
  page. **Not installed on HOG.** HOG's Thank You page uses `thank_you_button`
  ("Get Status") → Member Access Hub.
- **The Member Access Hub (`member-hub.ejs` / `my-access.ejs`) shows nothing for day
  passes.** It opens from a plain URL carrying the member id, so it must NOT render a
  bearer QR without a signed token.
- **Not using Kisi to resend:** Kisi only emails a link when given the buyer's email,
  which we deliberately stopped (its email includes the access link that unlocks from
  anywhere; may count against Kisi's visitor-link quota). Whether the Kisi dashboard
  shows the QR for API-created links is unverified.

## Options (recommended: 2 + 1)

1. **Staff "Resend day pass" button** on the member row in AccessSync. Re-sends the
   `day_pass_ready` email to the address on the order. Operator-authed, small.
   Needs a fresh dedup key per resend (current key is `accessId:planId:order:u1`).
2. **"Your day pass" card in the Member Access Hub.** The Get Status button's Velo
   backend asks AccessSync (HMAC-signed, like `/member/day-pass`) for a short-lived
   signed hub URL; the hub renders the QR via the existing `qr.png?t=` endpoint.
   Needs: new signed-hub-URL endpoint, hub card, updated `thank_you_button` snippet.
3. **Customer "Email me my code again."** Enter email → if it matches an active day
   pass, re-send the email to that address only (never shown on screen). Covers guest
   checkouts. Needs rate limiting.
4. **Install `thank_you_day_pass` on HOG's Thank You page.** No code change; logged-in
   buyers only. Cleanup if used: drop the dead `unlockUrl` button branch (the API always
   returns `unlockUrl: null`).
5. **Apple / Google Wallet pass.** Best UX, auto-expires; needs developer accounts.
   Later.

## Done when

- A buyer who lost the email can get their code back without staff (option 2 or 3).
- Staff can re-send a code from AccessSync in one click (option 1).
- No path shows a QR to an unauthenticated request; every QR URL stays signed and
  short-lived; no link URL or QR image is ever logged.
