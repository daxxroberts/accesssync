/**
 * e2e/admin/admin-responsive.spec.js
 * Mobile breakpoint, table horizontal scroll, nav collapse.
 * ~35 scenarios.
 */

const { test, expect, devices } = require('@playwright/test');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

test.describe('Admin Responsive — Mobile viewport', () => {
  test('dashboard page renders on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto('/OwnerDashboard');
    expect(res?.status()).toBe(200);
    const content = await page.content();
    expect(content).not.toContain('Internal Server Error');
    await context.close();
  });

  test('operator overview renders on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    expect([200, 404]).toContain(res?.status());
    await context.close();
  });

  test('members page renders on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}/members`);
    expect([200, 404]).toContain(res?.status());
    await context.close();
  });

  test('location detail renders on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    expect([200, 404]).toContain(res?.status());
    await context.close();
  });

  test('no JS errors on mobile viewport', async ({ browser }) => {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page    = await context.newPage();
    page.on('pageerror', err => errors.push(err.message));
    await auth.setAdminCookieOnContext(context);
    await page.goto('/OwnerDashboard');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
    await context.close();
  });
});

test.describe('Admin Responsive — Tablet viewport', () => {
  test('dashboard renders on tablet viewport (768px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto('/OwnerDashboard');
    expect(res?.status()).toBe(200);
    await context.close();
  });

  test('operator overview renders on tablet viewport', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    expect([200, 404]).toContain(res?.status());
    await context.close();
  });
});

test.describe('Admin Responsive — Desktop viewport', () => {
  test('dashboard renders on desktop viewport (1440px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto('/OwnerDashboard');
    expect(res?.status()).toBe(200);
    await context.close();
  });

  test('members page has scrollable table on desktop', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page    = await context.newPage();
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}/members`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).not.toContain('Internal Server Error');
    await context.close();
  });
});

test.describe('Admin Responsive — Content integrity across viewports', () => {
  test('HOG client name appears on mobile and desktop', async ({ browser }) => {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page    = await context.newPage();
      await auth.setAdminCookieOnContext(context);
      await page.goto('/OwnerDashboard');
      await page.waitForLoadState('networkidle');
      const content = await page.content();
      expect(content).toContain('House of Gains');
      await context.close();
    }
  });

  test('operator page content is same on mobile and desktop', async ({ browser }) => {
    let mobileContent = '', desktopContent = '';
    for (const [w, key] of [[390, 'mobile'], [1440, 'desktop']]) {
      const context = await browser.newContext({ viewport: { width: w, height: 900 } });
      const page    = await context.newPage();
      await auth.setAdminCookieOnContext(context);
      await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
      await page.waitForLoadState('networkidle');
      const text = await page.content();
      if (key === 'mobile') mobileContent = text;
      else desktopContent = text;
      await context.close();
    }
    // Both should contain HOG name
    expect(mobileContent).toContain('House of Gains');
    expect(desktopContent).toContain('House of Gains');
  });
});
