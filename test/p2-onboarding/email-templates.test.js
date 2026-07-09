/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  DR-052 — email template layer (core/email-templates.js)                │
 * │                                                                         │
 * │  Pure-function tests, zero mocks: the template layer has no I/O by      │
 * │  design (mirrors billing-snapshot.js). Guards:                          │
 * │    - XSS: every interpolated value is escaped (gym/member/plan names    │
 * │      are operator/Wix-supplied — hostile by assumption)                 │
 * │    - hex color validation + neutral fallbacks (never DR-014 indigo —   │
 * │      these are the GYM's emails)                                        │
 * │    - multipart discipline: a text part is ALWAYS generated              │
 * │    - footer carries the gym's admin contact (Builder spec)              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const t = require('../../core/email-templates');

const BRANDING = {
  gymName: 'House of Gains',
  logoUrl: 'https://example.com/logo.png',
  primaryColor: '#112233',
  secondaryColor: '#445566',
  adminEmail: 'chad@hog.com',
};

describe('[P2] DR-052 escapeHtml — hostile input never reaches HTML raw', () => {
  test('escapes the five HTML metacharacters', () => {
    expect(t.escapeHtml(`<script>alert("x")&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;');
  });
  test('null/undefined render as empty string', () => {
    expect(t.escapeHtml(null)).toBe('');
    expect(t.escapeHtml(undefined)).toBe('');
  });
});

describe('[P2] DR-052 isValidHexColor', () => {
  test('accepts #rrggbb', () => {
    expect(t.isValidHexColor('#4F6EF7')).toBe(true);
    expect(t.isValidHexColor('#000000')).toBe(true);
  });
  test('rejects everything else', () => {
    for (const bad of ['4F6EF7', '#fff', '#12345', '#1234567', 'red', '#GGGGGG', '', null, undefined, 'javascript:alert(1)']) {
      expect(t.isValidHexColor(bad)).toBe(false);
    }
  });
});

describe('[P2] DR-052 brandingFromClientRow — fallbacks', () => {
  test('invalid colors fall back to neutral #333333, never AccessSync indigo', () => {
    const b = t.brandingFromClientRow({ name: 'Gym', email_primary_color: 'nope', email_secondary_color: null });
    expect(b.primaryColor).toBe('#333333');
    expect(b.secondaryColor).toBe('#333333');
    expect(b.primaryColor).not.toBe('#4F6EF7');
  });
  test('non-https logo URL is dropped', () => {
    const b = t.brandingFromClientRow({ name: 'Gym', email_logo_url: 'http://insecure.com/x.png' });
    expect(b.logoUrl).toBeNull();
  });
  test('notification_email becomes the admin contact', () => {
    const b = t.brandingFromClientRow({ name: 'Gym', notification_email: 'admin@gym.com' });
    expect(b.adminEmail).toBe('admin@gym.com');
  });
});

describe('[P2] DR-052 renderLayout — the three-input branding model', () => {
  test('logo header on primary band; secondary drives CTA; white body; admin contact + powered-by footer', () => {
    const { html, text } = t.renderLayout({
      branding: BRANDING, heading: 'Heading', bodyHtml: '<p>Body</p>', bodyText: 'Body',
      ctaText: 'Open app', ctaUrl: 'https://example.com/app',
    });
    expect(html).toContain('background-color:#112233');           // primary band
    expect(html).toContain('background-color:#445566');           // secondary CTA
    expect(html).toContain('https://example.com/logo.png');       // logo
    expect(html).toContain('chad@hog.com');                        // admin contact footer
    expect(html).toContain('Powered by AccessSync');
    expect(html).toContain('background-color:#ffffff');            // white body card
    expect(text).toContain('Open app: https://example.com/app');   // text part mirrors CTA
  });

  test('no logo → gym-name text header fallback', () => {
    const { html } = t.renderLayout({
      branding: Object.assign({}, BRANDING, { logoUrl: null }),
      heading: 'H', bodyHtml: '<p>B</p>', bodyText: 'B',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('House of Gains');
  });
});

describe('[P2] DR-052 content renderers — escaping, subjects, text part', () => {
  const HOSTILE = Object.assign({}, BRANDING, { gymName: '<img src=x onerror=alert(1)>Gym' });

  test('renderAccessReady: hostile gym/plan names are escaped; text part present', () => {
    const out = t.renderAccessReady({
      branding: HOSTILE,
      member: { firstName: '<b>Jane</b>' },
      plans: [{ planName: '<svg/onload=x>Couples', doorName: 'Front & Back' }],
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('<svg');
    expect(out.html).not.toContain('<b>Jane</b>');
    expect(out.html).toContain('&lt;svg/onload=x&gt;Couples');
    expect(out.html).toContain('Front &amp; Back');
    expect(out.text.length).toBeGreaterThan(20);
    expect(out.subject).toContain('is ready');
  });

  // 2026-07-08: iOS/Android links verified live against the App Store / Play Store
  // (Android package id is de.kisi.android — a Gmail-extraction encoding artifact had
  // previously mangled this; see MEMBER_EMAILS_SPEC.md section 3).
  test('renderAccessReady: includes the verified iOS + Android Kisi app links, in both parts', () => {
    const out = t.renderAccessReady({
      branding: BRANDING, member: { firstName: 'Jane' },
      plans: [{ planName: 'Monthly', doorName: 'Front Door' }],
    });
    expect(out.html).toContain('https://apps.apple.com/us/app/kisi/id687291321');
    expect(out.html).toContain('https://play.google.com/store/apps/details?id=de.kisi.android');
    expect(out.text).toContain('https://apps.apple.com/us/app/kisi/id687291321');
    expect(out.text).toContain('https://play.google.com/store/apps/details?id=de.kisi.android');
  });

  test('renderAccessRemoved: names plan + gym, text part present', () => {
    const out = t.renderAccessRemoved({ branding: BRANDING, member: { firstName: 'Daxx' }, planName: 'Couples' });
    expect(out.subject).toBe('Your Couples access at House of Gains has ended');
    expect(out.html).toContain('Couples');
    expect(out.text).toContain('has ended');
  });

  test('renderSubMemberInvite: holder + plan + gym in subject and body', () => {
    const out = t.renderSubMemberInvite({
      branding: BRANDING, member: { firstName: 'Jamie' }, holderName: 'Daxx Roberts', planName: 'Family',
    });
    expect(out.subject).toBe('Daxx Roberts added you to Family at House of Gains');
    expect(out.html).toContain('Daxx Roberts');
    expect(out.html).toContain('Family');
    expect(out.text).toContain('added you to their Family plan');
  });

  test('every renderer always emits a non-empty text part (deliverability)', () => {
    for (const out of [
      t.renderAccessReady({ branding: BRANDING, member: {}, plans: [] }),
      t.renderAccessRemoved({ branding: BRANDING, member: {}, planName: null }),
      t.renderSubMemberInvite({ branding: BRANDING, member: {}, holderName: null, planName: null }),
    ]) {
      expect(typeof out.text).toBe('string');
      expect(out.text.trim().length).toBeGreaterThan(0);
      expect(typeof out.html).toBe('string');
      expect(out.html).toContain('Powered by AccessSync');
    }
  });
});
