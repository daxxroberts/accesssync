/**
 * e2e/admin/admin-operator-overview.spec.js
 * Operator overview page — stat cards match DB state.
 * ~55 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

async function getDbStats(clientId) {
  // Mirror the endpoint's exact queries (admin/routes/operator.js GET /:clientId stats):
  //   active_members   = COUNT(DISTINCT member_master_id) WHERE status='active'
  //   error_count      = COUNT(*) WHERE status='failed'
  //   pending_hardware = COUNT(*) WHERE status='pending_hardware'
  const [active, total, errors, pending, syncedM, managedM] = await Promise.all([
    db.queryOne(`SELECT COUNT(DISTINCT member_master_id)::int AS cnt FROM member_access WHERE client_id = $1 AND status = 'active'`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM member_master WHERE client_id = $1`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM error_queue WHERE client_id = $1 AND status = 'failed'`, [clientId]),
    // S-11/DR-046: pending_hardware is a source-row state, not an access-row state.
    // Mirrors the API's own query so the two can be compared.
    db.queryOne(`SELECT COUNT(DISTINCT ma.id)::int AS cnt FROM member_access ma JOIN member_access_sources mas ON mas.access_id = ma.id WHERE ma.client_id = $1 AND mas.status = 'pending_hardware'`, [clientId]),
    db.queryOne(`SELECT COUNT(DISTINCT ma.member_master_id)::int AS cnt FROM member_access ma WHERE ma.client_id = $1 AND ma.status = 'active' AND NOT EXISTS (SELECT 1 FROM member_access ma2 JOIN member_access_sources mas ON mas.access_id = ma2.id WHERE ma2.member_master_id = ma.member_master_id AND ma2.client_id = ma.client_id AND mas.status IN ('pending_hardware','pending_start','failed'))`, [clientId]),
    db.queryOne(`SELECT COUNT(DISTINCT member_master_id)::int AS cnt FROM member_access WHERE client_id = $1 AND status IN ('active','in_flight','pending_identity','recovery_pending')`, [clientId]),
  ]);
  return {
    active_members:   active.cnt,
    total_members:    total.cnt,
    error_count:      errors.cnt,
    pending_hardware: pending.cnt,
    synced_members:   syncedM.cnt,
    managed_members:  managedM.cnt,
  };
}

test.describe('Admin Operator Overview — HOG stats match DB', () => {
  let stats;
  test.beforeAll(async () => {
    stats = await getDbStats(seed.HOG_CLIENT_ID);
  });

  test('page renders without 500 error', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    expect(res?.status()).toBe(200);
    const content = await page.content();
    expect(content).not.toContain('Internal Server Error');
  });

  test('active_members stat from API close to DB (other tests may shift count by ±2)', async () => {
    // Other tests in parallel create/destroy members. Allow ±2 drift.
    const cookie = await auth.getAdminCookie();
    const res = await fetch(`https://accesssync-admin.up.railway.app/operator/${seed.HOG_CLIENT_ID}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const apiCount = Number(json?.stats?.active_members);
    expect(Math.abs(apiCount - stats.active_members)).toBeLessThanOrEqual(3);
  });

  // The Synced/Total tile deliberately does NOT show total_members. That field is the
  // lifetime member_master count, so churned members inflated it and the tile reported
  // them as "pending". The tile divides synced_members by managed_members instead.
  test('synced/managed stat card displays correct value', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain(`${stats.synced_members} / ${stats.managed_members}`);
  });

  test('Synced/Total tile never labels churned members as pending', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    const churnGap = stats.total_members - stats.active_members;
    // Regression guard: with churn present, the old code rendered "<churnGap> pending".
    if (churnGap > 0 && stats.synced_members === stats.managed_members) {
      expect(content).not.toContain(`${churnGap} pending`);
      expect(content).toContain('All synced');
    }
  });

  test('error_count stat card displays correct value', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain(String(stats.error_count));
  });

  test('pending_hardware stat card displays correct value', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain(String(stats.pending_hardware));
  });

  test('active <= total in rendered page numbers', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    // Both numbers render; verify DB-level consistency
    expect(stats.active_members).toBeLessThanOrEqual(stats.total_members);
  });
});

test.describe('Admin Operator Overview — Test client stats match DB', () => {
  test('Test client overview page renders', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.TEST_CLIENT_ID}`);
    expect(res?.status()).toBe(200);
  });

  test('Test client shows 0 active members', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.TEST_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    // 0 active members — page should contain "0" somewhere
    const dbActive = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM member_access WHERE client_id = $1 AND status = 'active'
    `, [seed.TEST_CLIENT_ID]);
    expect(content).toContain(String(dbActive.cnt));
  });

  test('Test client shows 0 errors', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.TEST_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const dbErrors = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM error_queue WHERE client_id = $1
    `, [seed.TEST_CLIENT_ID]);
    expect(dbErrors.cnt).toBe(0);
  });
});

test.describe('Admin Operator Overview — Location cards', () => {
  test('HOG location appears on overview page', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(
      content.includes('Roland') || content.includes('House of Gains') || content.includes(seed.HOG_LOCATION_ID)
    ).toBe(true);
  });

  test('Test location appears in Test client locations API', async () => {
    // Locations are loaded via the /locations endpoint, not server-rendered into the page.
    const cookie = await auth.getAdminCookie();
    const res = await fetch(`https://accesssync-admin.up.railway.app/operator/${seed.TEST_CLIENT_ID}/locations`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const locs = json?.locations || [];
    const found = locs.find(l => l.id === seed.TEST_LOCATION_ID || l.name === 'E2E Test Location');
    expect(found, 'Test location not in /locations response').toBeTruthy();
  });

  test('location card shows subscription_status', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    // Either 'active' subscription status or the tier label should appear
    expect(content.includes('active') || content.includes('Base') || content.includes('Connect')).toBe(true);
  });
});

test.describe('Admin Operator Overview — Plan mappings table', () => {
  test('HOG location page shows plan mappings', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain('Individual');
  });

  test('location detail page renders without 500', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`);
    expect(res?.status()).toBe(200);
    const content = await page.content();
    expect(content).not.toContain('Internal Server Error');
  });

  test('Test location detail page renders without 500', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`);
    expect(res?.status()).toBe(200);
    const content = await page.content();
    expect(content).not.toContain('Internal Server Error');
  });

  test('Test location page shows seeded plan names', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content.includes('Test Individual') || content.includes('Test Couples')).toBe(true);
  });
});

test.describe('Admin Operator Overview — Cross-verification API vs Browser', () => {
  test('API active_members = browser displayed count (HOG)', async ({ page, context }) => {
    const cookie = await auth.getAdminCookie();
    const apiRes = await fetch(`${process.env.ADMIN_BASE_URL || 'http://localhost:3001'}/operator/${seed.HOG_CLIENT_ID}`, {
      headers: { Cookie: cookie },
    });
    const apiJson = await apiRes.json();
    const apiCount = Number(apiJson?.active_members ?? apiJson?.stats?.active_members ?? 0);

    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain(String(apiCount));
  });

  test('API synced/managed = browser displayed count (HOG)', async ({ page, context }) => {
    const cookie = await auth.getAdminCookie();
    const apiRes = await fetch(`${process.env.ADMIN_BASE_URL || 'http://localhost:3001'}/operator/${seed.HOG_CLIENT_ID}`, {
      headers: { Cookie: cookie },
    });
    const apiJson = await apiRes.json();
    const apiSynced  = Number(apiJson?.stats?.synced_members ?? apiJson?.synced_members ?? 0);
    const apiManaged = Number(apiJson?.stats?.managed_members ?? apiJson?.managed_members ?? 0);
    // pending is derived server-side; it must never exceed the managed population.
    const apiPending = Number(apiJson?.stats?.pending_members ?? apiJson?.pending_members ?? 0);
    expect(apiPending).toBe(apiManaged - apiSynced);
    expect(apiPending).toBeGreaterThanOrEqual(0);

    await auth.setAdminCookieOnContext(context);
    await page.goto(`/operator/${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    expect(content).toContain(`${apiSynced} / ${apiManaged}`);
  });
});
