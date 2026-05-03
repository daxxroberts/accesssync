/**
 * Velo lightbox code — AccessSync Hub lightbox
 *
 * Paste this into the Velo code panel of the AccessSync Hub lightbox.
 * The lightbox must contain an HTML Component with ID "html1".
 *
 * This receives the memberId + clientId passed by the Thank You page,
 * then loads the AccessSync member hub straight to the sync status screen.
 */

import wixWindow from 'wix-window';

const ADMIN_HUB = 'https://accesssync-admin.up.railway.app';

$w.onReady(function () {
  const data = wixWindow.lightbox.getContext();

  if (!data || !data.memberId || !data.clientId) {
    // No context passed — close silently
    wixWindow.lightbox.close();
    return;
  }

  const src = `${ADMIN_HUB}/member-hub`
    + `?memberId=${encodeURIComponent(data.memberId)}`
    + `&clientId=${encodeURIComponent(data.clientId)}`
    + `&tab=status`;

  $w('#html1').src = src;
});
