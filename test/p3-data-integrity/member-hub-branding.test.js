/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: the Access Hub's "Back to {gym}" link and gym bar            │
 * │                                                                         │
 * │  The link sends a member off our page, so its address must be the gym's │
 * │  own stored site and nothing else (WARD 2026-10-05): https, no          │
 * │  user:pass@ lookalike hosts, no query/fragment, and no link for an      │
 * │  archived or inactive gym. An unknown gym shows plain AccessSync, never │
 * │  a made-up "Your gym" band.                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const ejs = require('ejs');
const path = require('path');
const { safeSiteUrl, hubBranding } = require('../../core/member-hub-branding');
const { CONNECTORS } = require('../../core/connector-branding');

const HOG = {
  name: 'House of Gains',
  email_logo_url: 'https://cdn.example.com/hog.png',
  email_primary_color: '#333333',
  email_secondary_color: '#ffdb29',
  source_site_url: 'https://www.houseofgainsthegym.com',
  status: 'active',
  archived_at: null,
};

describe('[P3] safeSiteUrl — only a clean https address is ever linked', () => {
  test.each([
    ['https://www.houseofgainsthegym.com',            'https://www.houseofgainsthegym.com/'],
    ['  https://gym.example.com/home?x=1#top ',       'https://gym.example.com/home'],
  ])('%s → %s', (raw, out) => expect(safeSiteUrl(raw)).toBe(out));

  test.each([
    ['javascript:alert(1)'],
    ['http://gym.example.com'],
    ['https://real-gym.com@evil.example'],
    ['https://user:pw@gym.example.com'],
    ['https://localhost'],
    ['data:text/html,hi'],
    ['not a url'],
    [''],
    [null],
  ])('%s → no link', (raw) => expect(safeSiteUrl(raw)).toBeNull());
});

describe('[P3] hubBranding — what the hub shows for a gym', () => {
  test('House of Gains: logo, dark buttons, white bar text, link home', () => {
    const b = hubBranding(HOG);
    expect(b).toMatchObject({
      gymName: 'House of Gains', primaryColor: '#333333',
      buttonColor: '#333333',          // the yellow never fills a button
      barText: '#ffffff',
      siteUrl: 'https://www.houseofgainsthegym.com/',
    });
  });

  test('archived or inactive gym: branding stays, the link does not', () => {
    expect(hubBranding({ ...HOG, archived_at: new Date() }).siteUrl).toBeNull();
    expect(hubBranding({ ...HOG, status: 'suspended' }).siteUrl).toBeNull();
  });

  test('a light primary color gets dark bar text', () => {
    expect(hubBranding({ ...HOG, email_primary_color: '#ffdb29' }).barText).toBe('#1a1a1a');
  });

  test('unknown gym: everything null (plain AccessSync page, no "Your gym" band)', () => {
    expect(Object.values(hubBranding(undefined)).every(v => v === null)).toBe(true);
  });
});

describe('[P3] member hub page — the rendered link', () => {
  const render = (row) => {
    const b = hubBranding(row);
    return ejs.renderFile(path.join(__dirname, '../../admin/views/pages/member-hub.ejs'), {
      connectorRegistryJson: JSON.stringify(CONNECTORS),
      gymName: b.gymName, gymLogoUrl: b.logoUrl,
      gymPrimaryColor: b.primaryColor, gymSecondaryColor: b.secondaryColor,
      gymButtonColor: b.buttonColor, gymBarText: b.barText, gymSiteUrl: b.siteUrl,
    });
  };

  test('branded gym: bar + "Back to House of Gains" to its stored site, no AccessSync wordmark', async () => {
    const html = await render(HOG);
    expect(html).toContain('class="gym-bar"');
    expect(html).toContain('<span>Back to House of Gains</span>');
    expect(html).toContain('href="https://www.houseofgainsthegym.com/" target="_self" rel="noopener noreferrer"');
    expect(html).not.toContain('<span class="brand">Access</span>');
  });

  test('no saved site: logo bar, no back link', async () => {
    const html = await render({ ...HOG, source_site_url: null });
    expect(html).toContain('class="gym-bar"');
    expect(html).not.toContain('class="gym-back"');
  });

  test('unknown gym: today\'s AccessSync page, no bar, no link', async () => {
    const html = await render(undefined);
    expect(html).not.toContain('class="gym-bar"');
    expect(html).not.toContain('class="gym-back"');
    expect(html).toContain('<span class="brand">Access</span>');
  });

  test('a gym name is escaped, never raw HTML', async () => {
    const html = await render({ ...HOG, name: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
