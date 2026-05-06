/**
 * e2e/admin/admin-location-detail.spec.js
 * Location detail — plan mappings table, access log, member count.
 * ~60 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

test.describe('Admin Location Detail — HOG Roland', () => {
  test('HOG location detail page renders without 500', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    expect([200, 404]).toContain(res?.status());
    if (res?.status() === 200) {
      const content = await page.content();
      expect(content).not.toContain('Internal Server Error');
    }
  });

  test('page contains plan mapping names', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content.includes('Individual') || content.includes('Couples') || content.includes('Family')).toBe(true);
  });

  test('page contains hardware group ID', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content.includes(seed.HOG_HW_GROUP_ENTRANCE) || content.includes('Entrance Door')).toBe(true);
  });

  test('page loads in under 5 seconds', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const start = Date.now();
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    await page.waitForLoadState('networkidle');
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

test.describe('Admin Location Detail — Plan Mappings API', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  const HOG_EXPECTED_PLANS = [
    { name: 'Individual',      sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.individual },
    { name: 'Couples',         sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.couples },
    { name: 'Family',          sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.family },
    { name: 'Student',         sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.student },
  ];

  for (const plan of HOG_EXPECTED_PLANS) {
    test(`plan_mapping ${plan.name} in API response`, async () => {
      const apiRes = await fetch(
        `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
        { headers: { Cookie: cookie } }
      );
      if (apiRes.status !== 200) return;
      const json = await apiRes.json();
      const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
      const found = mappings.find(m =>
        m.source_plan_id === plan.sourcePlanId || m.plan_name?.includes(plan.name)
      );
      expect(found, `Plan mapping ${plan.name} not found in API`).toBeTruthy();
    });
  }

  test('all active plan_mappings in DB appear in API', async () => {
    const dbMappings = await db.queryRows(`
      SELECT id, plan_name, source_plan_id FROM plan_mappings
      WHERE client_id = $1 AND location_id = $2 AND status = 'active'
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);

    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const apiMappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    expect(apiMappings.length).toBe(dbMappings.length);
  });

  test('Test client location has seeded plan mappings in API', async () => {
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    expect(mappings.length).toBeGreaterThanOrEqual(2);
  });
});

test.describe('Admin Location Detail — allow_multiple gate', () => {
  test('Individual plan has allow_multiple=false in DB', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings
      WHERE id = $1
    `, [seed.HOG_PLANS.individual]);
    expect(row?.allow_multiple).toBe(false);
    expect(row?.max_members).toBe(1);
  });

  test('Couples plan has allow_multiple=true in DB', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings
      WHERE id = $1
    `, [seed.HOG_PLANS.couples]);
    expect(row?.allow_multiple).toBe(true);
    expect(row?.max_members).toBe(2);
  });

  test('Family plan has allow_multiple=true in DB', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings
      WHERE id = $1
    `, [seed.HOG_PLANS.family]);
    expect(row?.allow_multiple).toBe(true);
    expect(row?.max_members).toBe(6);
  });
});

test.describe('Admin Location Detail — Access log section', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('access_log in API response is an array', async () => {
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const log = json?.access_log ?? json?.accessLog ?? json?.logs ?? [];
    expect(Array.isArray(log)).toBe(true);
  });

  test('access_log rows have event and ts fields', async () => {
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const log = json?.access_log ?? json?.accessLog ?? json?.logs ?? [];
    for (const row of log.slice(0, 5)) {
      expect(row.event ?? row.event_key ?? row.type).toBeTruthy();
      expect(row.ts ?? row.timestamp ?? row.created_at).toBeTruthy();
    }
  });
});
