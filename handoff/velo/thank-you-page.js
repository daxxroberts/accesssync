/**
 * Velo page code — Post-Purchase Thank You page
 *
 * Paste this into the Wix Thank You / Order Confirmation page.
 * It opens the AccessSync lightbox and passes the member's ID so
 * the lightbox can load the sync status screen automatically.
 *
 * Setup (one-time, per page):
 *   1. Create a Wix Lightbox (Add Elements → Lightbox) and name it
 *      "AccessSync Status" — the LIGHTBOX_NAME constant below must match
 *      the page title exactly (case-sensitive) as shown in the Pages panel
 *   2. Inside the lightbox, add an HTML Component and set its ID to "html1"
 *   3. Set the HTML Component height to 800px in the editor
 *   4. Paste lightbox.js into the lightbox's Velo code panel
 *   5. Open the Velo code panel for the Thank You page and paste this file
 *   6. Save and publish
 *
 * What the member sees:
 *   The lightbox opens automatically after purchase. Inside it, the hub
 *   loads straight to the sync screen — a 4-step animation that tracks
 *   their access being provisioned. Once confirmed, the green success
 *   screen stays on screen. The member closes the lightbox manually.
 */

import wixUsers from 'wix-users';
import wixWindow from 'wix-window';

const LIGHTBOX_NAME = 'AccessSync Status';
const CLIENT_ID     = '15962eac-c767-46ad-8056-094f35a4a193';

$w.onReady(function () {
  const user = wixUsers.currentUser;

  if (!user.loggedIn) {
    return;
  }

  wixWindow.openLightbox(LIGHTBOX_NAME, {
    memberId: user.id,
    clientId: CLIENT_ID,
  });
});
