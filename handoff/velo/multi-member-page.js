/**
 * Velo page code — Member Hub (member area page)
 *
 * This goes on the Wix member area page where your members check their
 * door access and manage additional members on their plan. One component
 * on one page handles everything — access status, plan info, and member management.
 *
 * Setup (one-time, per page):
 *   1. In the Wix editor, add an HTML Component to this page and set its ID to "html1"
 *   2. Set the component's height to 800px in the editor — Wix does not allow
 *      code to change the height of an HTML Component, so set it manually
 *   3. Open the Velo code panel for this page and paste this entire file
 *   4. Save and publish
 *
 * That's it. When a logged-in member opens this page, the component loads
 * automatically with their account already connected — no extra config needed.
 */

import wixUsers from 'wix-users';

const ADMIN_HUB = 'https://accesssync-admin.up.railway.app';
const CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

$w.onReady(function () {
  const user = wixUsers.currentUser;

  if (!user.loggedIn) {
    // Member isn't logged in — hide the component, nothing to show
    $w('#html1').hide();
    return;
  }

  const memberId = user.id;
  const src = `${ADMIN_HUB}/member-hub?memberId=${encodeURIComponent(memberId)}&clientId=${encodeURIComponent(CLIENT_ID)}`;

  $w('#html1').src = src;
});
