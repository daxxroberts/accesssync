/**
 * core/connector-branding.js
 *
 * Single source of truth for hardware-connector display data (app icon, store
 * links, display name, on-device setup requirements), keyed by `hardwarePlatform`.
 * Consumed by both the member-facing email (core/email-templates.js) and the web
 * step guide (admin/views/pages/member-hub.ejs, injected server-side by
 * admin/server.js) so the two surfaces can never drift on icon/store-link values.
 *
 * getConnectorBranding() fails open to 'kisi' only for an UNRECOGNIZED
 * hardwarePlatform (today's only live connector). A recognized-but-stubbed
 * connector (seam) resolves to its own entry, which has null icon/links/
 * requirements — callers MUST null-guard before rendering an image, download
 * link, or requirements list, rather than assuming a value is always present.
 * Do not add a fallback that makes an unmapped/future connector silently show
 * Kisi's real store links — that's a wrong CTA for that connector's members,
 * not a cosmetic gap.
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
    // Kisi unlocks doors over Bluetooth and uses location to confirm proximity
    // to a reader — both have to stay on (not just "while using the app"), or
    // taps fail silently with no error a member can self-diagnose. Surfaced by
    // renderStepGuideTable/Text (core/email-templates.js) in every email that
    // tells a member to install the app.
    requirements: [
      'Bluetooth turned on',
      'Location permission set to "Always" in the Kisi app’s settings',
    ],
  },
  seam: {
    // Stubbed — post-V1 (DR-011). No live app-store presence yet; consumers
    // must render a neutral fallback rather than a broken image/dead link.
    displayName: 'Seam',
    iconUrl:     null,
    iosLink:     null,
    androidLink: null,
    requirements: null,
  },
};

/**
 * @param {string} [hardwarePlatform] e.g. 'kisi' | 'seam'
 * @returns {{displayName: string, iconUrl: string|null, iosLink: string|null, androidLink: string|null, requirements: string[]|null}}
 */
function getConnectorBranding(hardwarePlatform) {
  return CONNECTORS[hardwarePlatform] || CONNECTORS.kisi;
}

module.exports = { CONNECTORS, getConnectorBranding, KISI_APP_ICON_URL };
