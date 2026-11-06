/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING / MEMBER-FACING                                │
 * │  Scenario: the gym-branded day-pass page (admin /day-pass)              │
 * │                                                                         │
 * │  The Wix Thank You page has one button; it opens this page. The page    │
 * │  must wear the gym's own branding (the same helper the Member Hub and   │
 * │  the emails use), say where the QR is going, and never render anything  │
 * │  from the data as raw HTML.                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const ejs = require('ejs');
const path = require('path');
const { hubBranding } = require('../../core/member-hub-branding');

const HOG = {
  name: 'House of Gains',
  email_logo_url: 'https://cdn.example.com/hog.png',
  email_primary_color: '#333333',
  email_secondary_color: '#ffdb29',
  source_site_url: 'https://www.houseofgainsthegym.com',
  status: 'active',
  archived_at: null,
};

const render = (row, extra = {}) => {
  const b = hubBranding(row);
  return ejs.renderFile(path.join(__dirname, '../../admin/views/pages/day-pass.ejs'), {
    boot: { status: 'pending', email: 'buyer@example.com' },
    token: 'tok.sig',
    qrGuideUrl: null,
    gymName: b.gymName, gymLogoUrl: b.logoUrl,
    gymPrimaryColor: b.primaryColor, gymButtonColor: b.buttonColor,
    gymBarText: b.barText, gymSiteUrl: b.siteUrl,
    ...extra,
  });
};

describe('[P2] day-pass page — gym branding', () => {
  test('House of Gains: its logo on its primary color, its button color, a way back to its site', async () => {
    const html = await render(HOG);
    expect(html).toContain('<title>House of Gains — Day Pass</title>');
    expect(html).toContain('src="https://cdn.example.com/hog.png"');
    expect(html).toContain('--gym-primary:#333333');
    expect(html).toContain('--gym-btn:#333333');          // the yellow never fills a button
    expect(html).toContain('--gym-bar-text:#ffffff');
    expect(html).toContain('<span>Back to House of Gains</span>');
    expect(html).toContain('href="https://www.houseofgainsthegym.com/"');
    expect(html).toContain('Powered by AccessSync');
  });

  test('no saved site: logo band, no back link', async () => {
    const html = await render({ ...HOG, source_site_url: null });
    expect(html).toContain('class="band"');
    expect(html).not.toContain('class="gym-back"');
  });

  test('unknown gym or an expired link with no gym: plain AccessSync mark, no made-up band', async () => {
    const html = await render(undefined, { boot: { status: 'none' } });
    expect(html).not.toContain('class="band');
    expect(html).not.toContain('class="gym-back"');
    expect(html).toContain('class="as-only"');
    expect(html).not.toContain('Powered by AccessSync');
  });

  test('a gym name is escaped, never raw HTML', async () => {
    const html = await render({ ...HOG, name: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('[P2] day-pass page — data handling', () => {
  test('the pass data and token are JSON-escaped so they can never close the script tag', async () => {
    const html = await render(HOG, {
      boot: { status: 'ready', email: '</script><script>alert(1)</script>@x.com', qrUrl: 'https://core.test/member/day-pass/qr.png?t=a' },
      token: '</script><script>alert(2)</script>',
    });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).not.toContain('</script><script>alert(2)');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  test('says where the QR is going and keeps the copy free of "manage / check access"', async () => {
    const html = await render(HOG);
    expect(html).toContain('is also on its way to');
    expect(html).toContain('We are sending your QR code to');
    expect(html).toContain('Check your email for your QR code');
    expect(html).not.toMatch(/manage (your )?access|check (your )?access|get status/i);
  });

  test('the email is written with text nodes, never innerHTML', async () => {
    const html = await render(HOG);
    expect(html).toContain("el('strong', null, d.email)");
    expect(html).not.toMatch(/innerHTML\s*=\s*[^;]*d\.email/);
  });

  test('is never indexed and sends no referrer', async () => {
    const html = await render(HOG);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  test('the how-to-get-in guide button only ever points at https', async () => {
    const html = await render(HOG, { qrGuideUrl: 'javascript:alert(1)' });
    // the page script checks the scheme before it makes the link
    expect(html).toContain("/^https:\\/\\//.test(GUIDE_URL)");
  });
});
