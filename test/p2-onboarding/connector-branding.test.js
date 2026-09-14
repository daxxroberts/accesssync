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

  test('kisi requirements name Bluetooth + "Always" location (needed for reliable door unlocks)', () => {
    const c = getConnectorBranding('kisi');
    expect(Array.isArray(c.requirements)).toBe(true);
    expect(c.requirements.some(r => /bluetooth/i.test(r))).toBe(true);
    expect(c.requirements.some(r => /location/i.test(r) && /always/i.test(r))).toBe(true);
  });

  // Usage tips are distinct from requirements: how a tap works day to day, not
  // what has to be switched on. The one claim that matters most — you don't
  // have to open the app — must be there.
  test('kisi usageTips say you do not need to open the app to get in', () => {
    const c = getConnectorBranding('kisi');
    expect(Array.isArray(c.usageTips)).toBe(true);
    expect(c.usageTips.some(t => /open the app/i.test(t))).toBe(true);
  });

  // Sign-in is a member-initiated action inside the app (checkout email -> sign-in
  // link, no password). Kisi's own invite email is unreliable, so no surface may
  // tell a member to wait for or look for an email from Kisi.
  test('kisi usageTips explain in-app sign-in with the checkout email, and never point at a Kisi email', () => {
    const c = getConnectorBranding('kisi');
    expect(c.usageTips.some(t => /checkout/i.test(t) && /sign-in link/i.test(t) && /no password/i.test(t))).toBe(true);
    for (const t of [...c.usageTips, ...c.requirements]) {
      expect(t).not.toMatch(/email from kisi|kisi (will|sends?|emails?) you|wait for|look for|watch for|invitation/i);
    }
  });

  test('seam is a recognized key but a stub — null icon/links/requirements/usageTips, not a fallback to kisi', () => {
    const c = getConnectorBranding('seam');
    expect(c.displayName).toBe('Seam');
    expect(c.iconUrl).toBeNull();
    expect(c.iosLink).toBeNull();
    expect(c.androidLink).toBeNull();
    expect(c.requirements).toBeNull();
    expect(c.usageTips).toBeNull();
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
