/**
 * Velo page code — Post-Purchase Thank You page
 *
 * Drop this into the Wix Thank You / Order Confirmation page that contains
 * the HTML Component (#html1). The component src is set dynamically so the
 * logged-in member's ID is injected at runtime and the Status overlay fires
 * immediately via ?tab=status.
 *
 * Setup:
 *   1. Add an HTML Component to the Thank You page, ID it "html1"
 *   2. Set its height to ~600px initially (the hub will resize it automatically)
 *   3. Paste this file into the page's Velo code panel
 *
 * Behavior:
 *   - ?tab=status tells member-hub.ejs to show the sync status overlay on load
 *   - The overlay polls /member/access-status, animates the 4-step pipeline,
 *     and auto-dismisses to the My Access tab once provisioning completes
 *   - Member never has to manually close anything
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
