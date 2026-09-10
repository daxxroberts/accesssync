/**
 * core/connector-branding.js
 *
 * Single source of truth for hardware-connector display data (app icon, store
 * links, display name), keyed by `hardwarePlatform`. Consumed by both the
 * member-facing email (core/email-templates.js) and the web step guide
 * (admin/views/pages/member-hub.ejs, injected server-side by admin/server.js)
 * so the two surfaces can never drift on icon/store-link values.
 *
 * getConnectorBranding() fails open to 'kisi' only for an UNRECOGNIZED
 * hardwarePlatform (today's only live connector). A recognized-but-stubbed
 * connector (seam) resolves to its own entry, which has null icon/links —
 * callers MUST null-guard before rendering an image or download link, rather
 * than assuming a value is always present. Do not add a fallback that makes
 * an unmapped/future connector silently show Kisi's real store links — that's
 * a wrong CTA for that connector's members, not a cosmetic gap.
 */

'use strict';

// Same asset already used in the access_ready email (Builder ruling 2026-09-05):
// Kisi's own app-store icon, hosted by us rather than hot-linked — nominative
// use to help a member recognize the app, not a screenshot of Kisi's product UI.
const KISI_APP_ICON_URL = 'https://accesssync-admin.up.railway.app/kisi-app-icon.jpg';

const CONNECTORS = {
  kisi: {
    displayName: 'Kisi',
    iconUrl:     KISI_APP_ICON_URL,
    iosLink:     'https://apps.apple.com/us/app/kisi/id687291321',
    androidLink: 'https://play.google.com/store/apps/details?id=de.kisi.android',
  },
  seam: {
    // Stubbed — post-V1 (DR-011). No live app-store presence yet; consumers
    // must render a neutral fallback rather than a broken image/dead link.
    displayName: 'Seam',
    iconUrl:     null,
    iosLink:     null,
    androidLink: null,
  },
};

/**
 * @param {string} [hardwarePlatform] e.g. 'kisi' | 'seam'
 * @returns {{displayName: string, iconUrl: string|null, iosLink: string|null, androidLink: string|null}}
 */
function getConnectorBranding(hardwarePlatform) {
  return CONNECTORS[hardwarePlatform] || CONNECTORS.kisi;
}

module.exports = { CONNECTORS, getConnectorBranding, KISI_APP_ICON_URL };
