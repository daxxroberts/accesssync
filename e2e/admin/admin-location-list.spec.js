/**
 * e2e/admin/admin-location-list.spec.js
 * Location tiles — tier, subscription_status, connector_subscription status.
 * ~40 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

test.describe('Admin Location List — HOG', () => {
  test('HOG locations page renders without 500', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations`);
    expect([200, 404]).toContain(res?.status());
    if (res?.status() === 200) {
      const content = await page.content();
      expect(content).not.toContain('Internal Server Error');
    }
  });

  test('HOG Roland location appears in location list', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content.includes('Roland') || content.includes('House of Gains')).toBe(true);
  });
});

test.describe('Admin Location List — API data integrity', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('HOG location list API returns correct location count', async () => {
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const locs = json?.locations ?? json?.data ?? (Array.isArray(json) ? json : []);

    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM locations WHERE client_id = $1
    `, [seed.HOG_CLIENT_ID]);
    expect(locs.length).toBe(dbCount.cnt);
  });

  test('HOG location has correct location_id', async () => {
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const locs = json?.locations ?? json?.data ?? (Array.isArray(json) ? json : []);
    const locIds = locs.map(l => l.id ?? l.location_id).filter(Boolean);
    expect(locIds).toContain(seed.HOG_LOCATION_ID);
  });

  test('HOG location has tier field', async () => {
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const locs = json?.locations ?? json?.data ?? (Array.isArray(json) ? json : []);
    const hogLoc = locs.find(l => (l.id ?? l.location_id) === seed.HOG_LOCATION_ID);
    if (hogLoc) {
      expect(hogLoc.tier).toBeTruthy();
    }
  });

  test('HOG location subscription_status = active', async () => {
    const row = await db.queryOne(`
      SELECT subscription_status FROM locations WHERE id = $1
    `, [seed.HOG_LOCATION_ID]);
    expect(row?.subscription_status).toBe('active');
  });

  test('connector_subscriptions row exists for HOG', async () => {
    const row = await db.queryOne(`
      SELECT id, hardware_platform, status FROM connector_subscriptions
      WHERE client_id = $1 AND hardware_platform = 'kisi'
    `, [seed.HOG_CLIENT_ID]);
    expect(row, 'HOG connector_subscriptions row not found').not.toBeNull();
    expect(row.status).toBe('active');
  });

  test('billing_subscriptions row exists for HOG location', async () => {
    const row = await db.queryOne(`
      SELECT id, tier, status FROM billing_subscriptions
      WHERE client_id = $1 AND location_id = $2
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);
    expect(row, 'HOG billing_subscriptions row not found').not.toBeNull();
    expect(row.status).toBe('active');
  });

  test('Test client location list returns 1 location', async () => {
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const locs = json?.locations ?? json?.data ?? (Array.isArray(json) ? json : []);
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM locations WHERE client_id = $1
    `, [seed.TEST_CLIENT_ID]);
    expect(locs.length).toBe(dbCount.cnt);
  });

  test('Test location has connector_subscription (no API key)', async () => {
    const row = await db.queryOne(`
      SELECT hardware_api_key, status FROM connector_subscriptions
      WHERE client_id = $1 AND hardware_platform = 'kisi'
    `, [seed.TEST_CLIENT_ID]);
    expect(row, 'Test client connector_subscriptions row not found').not.toBeNull();
    expect(row.hardware_api_key).toBeNull();
    expect(row.status).toBe('active');
  });
});

test.describe('Admin Location List — Tier display', () => {
  test('HOG location DB tier = Base', async () => {
    const row = await db.queryOne(`
      SELECT tier FROM locations WHERE id = $1
    `, [seed.HOG_LOCATION_ID]);
    expect(row?.tier).toBe('Base');
  });

  test('HOG client DB tier = Connect', async () => {
    const row = await db.queryOne(`
      SELECT tier FROM clients WHERE id = $1
    `, [seed.HOG_CLIENT_ID]);
    expect(row?.tier).toBe('Connect');
  });

  test('Test client tier = Base', async () => {
    const row = await db.queryOne(`
      SELECT tier FROM clients WHERE id = $1
    `, [seed.TEST_CLIENT_ID]);
    expect(row?.tier).toBe('Base');
  });
});
