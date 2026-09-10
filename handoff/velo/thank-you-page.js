/**
 * Velo page code — Post-Purchase Thank You page
 *
 * Paste this into the Wix Thank You / Order Confirmation page (and the
 * Bookings confirmation page, if used). Redirects the member's own browser
 * tab straight to their AccessSync status page after purchase — a same-tab
 * full-page redirect, not a popup. This is deliberate: an auto-opened new
 * window/tab on page load (not a click) gets blocked by most browsers'
 * popup blockers, so a same-tab redirect is the only reliable "just show me
 * what's happening" experience that doesn't need a click first.
 *
 * Matches core/SNIPPET_REGISTRY.json's `thank_you_redirect` template —
 * this file and the registry template must stay in sync.
 *
 * Setup (one-time, per page):
 *   1. Open the Velo code panel for the Thank You page and paste this file.
 *   2. Save and publish.
 *
 * Superseded lightbox flow: this used to open a Wix Lightbox ("AccessSync
 * Status") containing an iframe of the member hub. See lightbox.js in this
 * same folder for the deprecation note and manual cleanup steps — that
 * Lightbox element should be removed from the Wix Editor once this file is
 * live, in the SAME session as the code deploy (the Lightbox iframes
 * /member-hub directly, so the redesigned page renders inside it
 * immediately on deploy regardless of when this Velo change ships).
 *
 * What the member sees:
 *   Their browser navigates straight to the AccessSync status page, which
 *   shows the 5-stage horizontal pipeline animating while access is
 *   provisioned, then the "you're all set" screen with their active doors
 *   and a branded "get the app" card.
 */

import wixLocationFrontend from 'wix-location-frontend';
import { currentMember } from 'wix-members-frontend';

const ACCESSSYNC_URL = 'https://accesssync-admin.up.railway.app';
const CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

$w.onReady(async function () {
  try {
    const member = await currentMember.getMember();
    if (!member?._id) return;
    wixLocationFrontend.to(
      ACCESSSYNC_URL + '/member-hub'
      + '?memberId=' + encodeURIComponent(member._id)
      + '&clientId=' + encodeURIComponent(CLIENT_ID)
      + '&tab=status'
    );
  } catch (e) {
    console.error('AccessSync redirect error:', e);
  }
});
