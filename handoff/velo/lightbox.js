/**
 * @deprecated Velo lightbox code — AccessSync Hub lightbox
 *
 * SUPERSEDED — no page-code replacement needed. member-hub.ejs's own "My
 * Access" data-load path already auto-shows the same setup-animation
 * overlay whenever it detects an in-flight/pending status, with no
 * ?tab=status param required — so the My Access button (my_access_page
 * snippet, id #btnMyAccess) is genuinely dual-purpose: the same button a
 * member clicks any day also happens to show live setup progress if they
 * click it right after buying. There is no separate Thank You page
 * snippet anymore (an earlier version of this handoff briefly added one,
 * `thank-you-page.js` — removed as redundant once this was confirmed).
 *
 * IMPORTANT — this file is kept for reference only, but the Lightbox it
 * describes may still be LIVE on an already-published Wix site (it was
 * live on House of Gains as of 2026-09, hardcoded to that client's real ID
 * below) until someone completes the Wix Editor pass:
 *   1. Remove any post-purchase page code that still opens this Lightbox
 *      (the Thank You page needs no AccessSync code at all now)
 *   2. Delete the "AccessSync Status" Lightbox element and this code from
 *      the Wix Editor entirely
 * Do this in the SAME session as deploying the server-side member-hub.ejs
 * changes — the Lightbox's HTML Component loads /member-hub directly, so a
 * deploy alone changes what renders inside it immediately, and its
 * hand-set height (800px) was tuned for the old 4-stage vertical layout —
 * check/widen it as an interim step if the Lightbox is still live when the
 * deploy ships and this cleanup hasn't happened yet.
 *
 * Original purpose: received the memberId + clientId passed by the old
 * Thank You page lightbox trigger, then loaded the AccessSync member hub
 * straight to the sync status screen inside an HTML Component (id "html1").
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
