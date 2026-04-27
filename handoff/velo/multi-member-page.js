/**
 * Velo page code — Member Hub (member area page)
 *
 * Drop this into the Wix page that contains the HTML Component (#html1).
 * The HTML Component src is left blank in the editor — this code sets it
 * dynamically so the logged-in member's ID is always injected at runtime.
 *
 * Replaces the old multi-member, my-access, and sync-status iframes.
 * One HTML Component on one Wix page covers all three interactions.
 *
 * Setup:
 *   1. Add an HTML Component to the page, ID it "html1"
 *   2. Set its height to ~600px initially (the widget will resize it automatically)
 *   3. Paste this file into the page's Velo code panel
 *
 * For the post-purchase Thank You page: append &tab=status to the src URL
 * so the sync status overlay fires immediately on load.
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

  // Auto-resize the iframe to match the widget's content height
  $w('#html1').onMessage((event) => {
    if (event.data?.type === 'resize' && typeof event.data.height === 'number') {
      $w('#html1').height = event.data.height;
    }
  });
});
