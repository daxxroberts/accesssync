/**
 * core/connector-branding.js
 *
 * Single source of truth for hardware-connector display data (app icon, store
 * links, display name, on-device setup requirements, day-to-day usage tips),
 * keyed by `hardwarePlatform`.
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
// Terminal Pro with a phone held below it — the same Kisi product image the QR
// entry guide PDF uses (credited "image: Kisi"). Shown in the day-pass email so the
// buyer knows what the reader looks like and where to hold the code.
const KISI_QR_READER_IMAGE_URL = 'https://accesssync-admin.up.railway.app/kisi-terminal-pro-qr.png';

const CONNECTORS = {
  kisi: {
    displayName: 'Kisi',
    iconUrl:     KISI_APP_ICON_URL,
    // The reader a QR day pass is scanned at. Only Terminal Pro reads QR codes.
    qrReader: {
      name:     'Kisi Terminal Pro',
      imageUrl: KISI_QR_READER_IMAGE_URL,
      width:    280,
      height:   682,
      credit:   'image: Kisi',
    },
    iosLink:     'https://apps.apple.com/us/app/kisi/id687291321',
    androidLink: 'https://play.google.com/store/apps/details?id=de.kisi.android',
    // Kisi unlocks doors over Bluetooth and uses location to confirm proximity
    // to a reader — both have to stay on (not just "while using the app"), or
    // taps fail silently with no error a member can self-diagnose. Surfaced by
    // the access-ready / sub-member emails (core/email-templates.js) in every email
    // that tells a member to install the app.
    requirements: [
      'Bluetooth on (Android: NFC on)',
      'Location set to "Always" for the Kisi app',
    ],
    // Why the requirements matter, in one line a member can act on (same source as
    // the comment above). Shown under the requirements callout.
    requirementsWhy: 'Kisi uses Bluetooth to talk to the reader and your location to confirm you are at the door. If either one is off, the door just won\'t open, and you won\'t see an error.',
    // First-run setup, in order, for the access-ready email. Same facts as
    // requirements + usageTips[0], written as steps; sign-in stays member-initiated.
    // usageTips minus the sign-in line — for emails that already walk through sign-in
    // as a setup step, so the "at the door" list doesn't repeat it.
    doorTips: [
      'No need to open the app to get in. Keep your phone on you.',
      'At the door, hold your phone to the reader until it unlocks.',
    ],
    setupSteps: [
      { title: 'Download the Kisi app.', body: 'It\'s free on iPhone and Android. Use the buttons above.' },
      { title: 'Sign in with your checkout email.', body: 'Open Kisi and enter the email you used to buy your plan. Kisi emails you a sign-in link. Tap it on this phone. No password.' },
      { title: 'Turn on Bluetooth and Location.', body: 'Keep Bluetooth on (on Android, NFC too) and set Location to "Always" for Kisi, not "While using".' },
    ],
    // How to get in, day to day. Every line traces to docs.kisi.io or our own
    // createUser path (PARSE 2026-09-13). Sign-in is a member-initiated action
    // inside the app — never "wait for an email from Kisi": Kisi's own invite
    // is unreliable (Builder: fires about half the time), which is exactly why
    // AccessSync sends its own Resend emails. No "works from a bag with the
    // screen locked" claim until that's verified.
    usageTips: [
      'Sign in with your checkout email. Tap the sign-in link it sends. No password.',
      'No need to open the app to get in. Keep your phone on you.',
      'At the door, hold your phone to the reader until it unlocks.',
    ],
  },
  seam: {
    // Stubbed — post-V1 (DR-011). No live app-store presence yet; consumers
    // must render a neutral fallback rather than a broken image/dead link.
    displayName: 'Seam',
    iconUrl:     null,
    iosLink:     null,
    androidLink: null,
    qrReader:    null,
    requirements: null,
    requirementsWhy: null,
    doorTips:     null,
    setupSteps:   null,
    usageTips:    null,
  },
};

/**
 * @param {string} [hardwarePlatform] e.g. 'kisi' | 'seam'
 * @returns {{displayName: string, iconUrl: string|null, iosLink: string|null, androidLink: string|null, requirements: string[]|null, usageTips: string[]|null}}
 */
function getConnectorBranding(hardwarePlatform) {
  return CONNECTORS[hardwarePlatform] || CONNECTORS.kisi;
}

module.exports = { CONNECTORS, getConnectorBranding, KISI_APP_ICON_URL, KISI_QR_READER_IMAGE_URL };
