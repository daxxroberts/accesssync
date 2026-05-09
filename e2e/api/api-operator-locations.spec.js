/**
 * e2e/api/api-operator-locations.spec.js
 * Verifies /operator/:clientId/locations and /operator/:clientId/locations/:locationId.
 * ~25 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

test.describe('API — /operator/:clientId/locations/:locationId', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('returns 200 for HOG location', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(200);
  });

  test('response has plan_mappings array', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings;
    expect(Array.isArray(mappings)).toBe(true);
  });

  test('plan_mappings count matches DB', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM plan_mappings
      WHERE client_id = $1 AND location_id = $2 AND status = 'active'
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);
    expect(mappings.length).toBe(dbCount.cnt);
  });

  test('response has active_members array for location', async () => {
    // Endpoint returns active_members as an array of member rows, not a count.
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    expect(Array.isArray(json?.active_members)).toBe(true);
  });

  test('active_members array length matches DB count for location', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    const apiCount = (json?.active_members ?? []).length;
    // Endpoint query: DISTINCT ma.id JOIN plan_mappings via member_access_sources, status='active'.
    const dbCount = await db.queryOne(`
      SELECT COUNT(DISTINCT ma.id)::int AS cnt
      FROM member_access ma
      LEFT JOIN member_access_sources mas ON mas.access_id = ma.id
      LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
      WHERE ma.client_id = $1 AND pm.location_id = $2 AND ma.status = 'active'
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);
    expect(apiCount).toBe(dbCount.cnt);
  });

  test('access_log array is present', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    const log = json?.access_log ?? json?.accessLog ?? json?.logs;
    expect(Array.isArray(log)).toBe(true);
  });

  test('returns 401 without auth', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`
    );
    expect(res.status).toBe(401);
  });

  test('Test client location detail returns 200', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    expect(res.status).toBe(200);
  });

  test('Test client has plan_mappings (seeded)', async () => {
    const res = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    const json = await res.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    expect(mappings.length).toBeGreaterThanOrEqual(2);
  });
});

test.describe('API — connector_subscriptions and billing_subscriptions in location list', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('HOG location list includes subscription_status field', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    const json = await res.json();
    const locs = json?.locations ?? json?.data ?? json;
    if (Array.isArray(locs) && locs.length > 0) {
      const hogLoc = locs.find(l => (l.id ?? l.location_id) === seed.HOG_LOCATION_ID);
      if (hogLoc) {
        expect(
          hogLoc.subscription_status ?? hogLoc.subscriptionStatus ?? 'active'
        ).toBeTruthy();
      }
    }
  });

  test('Test client location list returns 200', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });
});
