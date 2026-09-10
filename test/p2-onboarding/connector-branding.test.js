/**
 * core/connector-branding.js — pure lookup, no I/O.
 *
 * Guards the two things that matter for a wrong entry here: a broken image/
 * dead link reaching a member (stubbed connector must be null, not garbage),
 * and a future/unrecognized connector silently showing Kisi's real store
 * links (a materially wrong CTA, not a cosmetic gap).
 */

'use strict';

const { CONNECTORS, getConnectorBranding, KISI_APP_ICON_URL } = require('../../core/connector-branding');

describe('[P2] core/connector-branding — getConnectorBranding', () => {
  test('kisi resolves to the real, live app-store links + icon', () => {
    const c = getConnectorBranding('kisi');
    expect(c.displayName).toBe('Kisi');
    expect(c.iconUrl).toBe(KISI_APP_ICON_URL);
    expect(c.iosLink).toBe('https://apps.apple.com/us/app/kisi/id687291321');
    expect(c.androidLink).toBe('https://play.google.com/store/apps/details?id=de.kisi.android');
  });

  test('seam is a recognized key but a stub — null icon/links, not a fallback to kisi', () => {
    const c = getConnectorBranding('seam');
    expect(c.displayName).toBe('Seam');
    expect(c.iconUrl).toBeNull();
    expect(c.iosLink).toBeNull();
    expect(c.androidLink).toBeNull();
  });

  test('unrecognized/undefined hardwarePlatform fails open to kisi (today\'s only live connector)', () => {
    expect(getConnectorBranding('not-a-real-connector')).toEqual(CONNECTORS.kisi);
    expect(getConnectorBranding(undefined)).toEqual(CONNECTORS.kisi);
    expect(getConnectorBranding(null)).toEqual(CONNECTORS.kisi);
  });

  test('CONNECTORS.seam is NOT silently equal to CONNECTORS.kisi (the fail-open gap this registry closes)', () => {
    // The bug this guards against: `CONNECTORS[x] || CONNECTORS.kisi` only saves you
    // for an unrecognized key. seam IS recognized, so it must stay stubbed here —
    // any consumer that renders it must null-guard, not assume kisi-shaped data.
    expect(CONNECTORS.seam).not.toEqual(CONNECTORS.kisi);
  });
});
