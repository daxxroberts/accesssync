/**
 * Velo page code — Post-Purchase Thank You page
 *
 * Paste this into the Wix Thank You / Order Confirmation page.
 * It loads the AccessSync member hub and immediately shows the sync
 * status screen so members see their access being activated in real time.
 *
 * Setup (one-time, per page):
 *   1. In the Wix editor, add an HTML Component to this page and set its ID to "html1"
 *   2. Set the component's initial height to around 600px — it resizes itself automatically
 *   3. Open the Velo code panel for this page and paste this entire file
 *   4. Save and publish
 *
 * What the member sees:
 *   The hub opens straight to the sync screen — a 4-step animation that tracks
 *   their access being provisioned. Once it's done, it slides over to their
 *   My Access tab automatically. They never have to tap anything.
 */

import wixUsers from 'wix-users';

const ADMIN_HUB = 'https://accesssync-admin.up.railway.app';
const CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

$w.onReady(function () {
  const user = wixUsers.currentUser;

  if (!user.loggedIn) {
    $w('#html1').hide();
    return;
  }

  const memberId = user.id;
  const src = `${ADMIN_HUB}/member-hub?memberId=${encodeURIComponent(memberId)}&clientId=${encodeURIComponent(CLIENT_ID)}&tab=status`;

  $w('#html1').src = src;

  // Auto-resize the iframe to match the hub's content height
  $w('#html1').onMessage((event) => {
    if (event.data?.type === 'resize' && typeof event.data.height === 'number') {
      $w('#html1').height = event.data.height;
    }
  });
});
