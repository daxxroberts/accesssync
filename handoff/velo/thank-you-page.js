/**
 * Velo page code — Post-Purchase Thank You page
 *
 * Paste this into the Wix Thank You / Order Confirmation page (and the
 * Bookings confirmation page, if used). Adds a "View My Access Status"
 * button that opens the member's AccessSync status page in a genuine new
 * browser tab — a real click, never an auto-opened window. This is
 * deliberate: nothing here ever gets rendered inside Wix (no iframe, no
 * Lightbox), and nothing opens automatically on page load, because a
 * window opened without a direct click gets silently blocked by Safari
 * and Chrome's default popup blockers. A click is the only reliable way
 * to get a real new tab — same pattern as the "My Access" button
 * (my_access_page snippet).
 *
 * Setup (one-time, per page):
 *   1. Add a Button element to the Thank You page (e.g. labeled
 *      "View My Access Status") and set its ID to "btnViewStatus".
 *   2. Open the Velo code panel for the Thank You page and paste this file.
 *   3. Save and publish.
 *
 * Superseded flows:
 *   - The old Lightbox popup (see lightbox.js in this folder) — removed.
 *   - An earlier version of this file did a same-tab redirect via
 *     wixLocationFrontend — replaced with this click-triggered new tab so
 *     the member keeps their Wix confirmation page open and gets their
 *     status in a separate tab, exactly like My Access already works.
 *
 * What the member sees:
 *   Their normal Wix order-confirmation content, plus a button. Clicking
 *   it opens a new tab showing the 5-stage horizontal pipeline animating
 *   while access is provisioned, then the "you're all set" screen with
 *   their active doors and a branded "get the app" card.
 */

import { currentMember } from 'wix-members-frontend';

const ADMIN_HUB = 'https://accesssync-admin.up.railway.app';
const CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

$w.onReady(async function () {
  const member = await currentMember.getMember();
  if (!member?._id) { $w('#btnViewStatus').hide(); return; }
  const url = ADMIN_HUB + '/member-hub'
    + '?memberId=' + encodeURIComponent(member._id)
    + '&clientId=' + encodeURIComponent(CLIENT_ID)
    + '&tab=status';
  $w('#btnViewStatus').link = url;
  $w('#btnViewStatus').target = '_blank';
  $w('#btnViewStatus').show();
});
