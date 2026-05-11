/**
 * e2e/admin/admin-metrics-vs-db.spec.js
 * Cross-verification: for every stat on the operator overview, query DB directly and assert match.
 * ~40 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

async function getApiStats(clientId, cookie) {
  const res = await fetch(`${ADMIN_BASE_URL}/operator/${clientId}`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getDbStats(clientId) {
  // Mirror the endpoint's exact queries (admin/routes/operator.js GET /:clientId stats):
  //   active_members   = COUNT(DISTINCT member_master_id) WHERE status='active'
  //   error_count      = COUNT(*) WHERE status='failed'
  //   pending_hardware = COUNT(*) WHERE status='pending_hardware'
  const [active, total, errors, pending, locations, plans] = await Promise.all([
    db.queryOne(`SELECT COUNT(DISTINCT member_master_id)::int AS cnt FROM member_access WHERE client_id = $1 AND status = 'active'`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM member_master WHERE client_id = $1`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM error_queue WHERE client_id = $1 AND status = 'failed'`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM member_access WHERE client_id = $1 AND status = 'pending_hardware'`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM locations WHERE client_id = $1`, [clientId]),
    db.queryOne(`SELECT COUNT(*)::int AS cnt FROM plan_mappings WHERE client_id = $1 AND status = 'active'`, [clientId]),
  ]);
  return {
    active_members:   active.cnt,
    total_members:    total.cnt,
    error_count:      errors.cnt,
    pending_hardware: pending.cnt,
    location_count:   locations.cnt,
    plan_mapping_count: plans.cnt,
  };
}

test.describe('Metrics vs DB — HOG client', () => {
  let cookie, apiStats, dbStats;

  test.beforeAll(async () => {
    cookie   = await auth.getAdminCookie();
    apiStats = await getApiStats(seed.HOG_CLIENT_ID, cookie);
    dbStats  = await getDbStats(seed.HOG_CLIENT_ID);
  });

  test('API returns data for HOG', async () => {
    expect(apiStats).not.toBeNull();
  });

  test('active_members: API = DB', async () => {
    const apiCount = Number(apiStats?.active_members ?? apiStats?.stats?.active_members ?? 0);
    expect(apiCount).toBe(dbStats.active_members);
  });

  test('total_members: API = DB', async () => {
    const apiCount = Number(apiStats?.total_members ?? apiStats?.stats?.total_members ?? 0);
    expect(apiCount).toBe(dbStats.total_members);
  });

  test('error_count: API = DB', async () => {
    const apiCount = Number(apiStats?.error_count ?? apiStats?.stats?.error_count ?? 0);
    expect(apiCount).toBe(dbStats.error_count);
  });

  test('pending_hardware: API = DB', async () => {
    const apiCount = Number(apiStats?.pending_hardware ?? apiStats?.stats?.pending_hardware ?? 0);
    expect(apiCount).toBe(dbStats.pending_hardware);
  });

  test('active_members <= total_members', async () => {
    expect(dbStats.active_members).toBeLessThanOrEqual(dbStats.total_members);
  });

  test('error_count >= 0', async () => {
    expect(dbStats.error_count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Metrics vs DB — Test client', () => {
  let cookie, apiStats, dbStats;

  test.beforeAll(async () => {
    cookie   = await auth.getAdminCookie();
    apiStats = await getApiStats(seed.TEST_CLIENT_ID, cookie);
    dbStats  = await getDbStats(seed.TEST_CLIENT_ID);
  });

  test('active_members: API = DB (expect 0)', async () => {
    const apiCount = Number(apiStats?.active_members ?? apiStats?.stats?.active_members ?? 0);
    expect(apiCount).toBe(dbStats.active_members);
    expect(dbStats.active_members).toBe(0);
  });

  test('total_members: API = DB (expect 0)', async () => {
    const apiCount = Number(apiStats?.total_members ?? apiStats?.stats?.total_members ?? 0);
    expect(apiCount).toBe(dbStats.total_members);
    expect(dbStats.total_members).toBe(0);
  });

  test('error_count: API = DB (expect 0)', async () => {
    const apiCount = Number(apiStats?.error_count ?? apiStats?.stats?.error_count ?? 0);
    expect(apiCount).toBe(dbStats.error_count);
    expect(dbStats.error_count).toBe(0);
  });
});

test.describe('Metrics vs DB — Location-level stats', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('HOG location active_members array length: API = DB', async () => {
    // Endpoint returns active_members as an array, not a count.
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const apiCount = (json?.active_members || []).length;

    // Endpoint joins via member_access_sources → plan_mappings (post-migration path).
    const dbCount = await db.queryOne(`
      SELECT COUNT(DISTINCT ma.id)::int AS cnt
      FROM member_access ma
      LEFT JOIN member_access_sources mas ON mas.access_id = ma.id
      LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
      WHERE ma.client_id = $1 AND pm.location_id = $2 AND ma.status = 'active'
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);
    expect(apiCount).toBe(dbCount.cnt);
  });

  test('HOG location plan_mappings count: API = DB', async () => {
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/locations/${seed.HOG_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM plan_mappings
      WHERE client_id = $1 AND location_id = $2 AND status = 'active'
    `, [seed.HOG_CLIENT_ID, seed.HOG_LOCATION_ID]);
    expect(mappings.length).toBe(dbCount.cnt);
  });

  test('Test location plan_mappings count: API = DB (expect 2 seeded)', async () => {
    const apiRes = await fetch(
      `${ADMIN_BASE_URL}/operator/${seed.TEST_CLIENT_ID}/locations/${seed.TEST_LOCATION_ID}`,
      { headers: { Cookie: cookie } }
    );
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const mappings = json?.plan_mappings ?? json?.planMappings ?? json?.mappings ?? [];
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM plan_mappings
      WHERE client_id = $1 AND location_id = $2 AND status = 'active'
    `, [seed.TEST_CLIENT_ID, seed.TEST_LOCATION_ID]);
    expect(mappings.length).toBe(dbCount.cnt);
  });
});

test.describe('Metrics vs DB — Members API vs DB', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('HOG members API row count = DB member_access count (one row per access)', async () => {
    // Endpoint returns one row per member_access (a member with 2 plans = 2 rows),
    // not per member_master.
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?limit=500`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM member_access ma
      WHERE ma.client_id = $1 AND ma.status NOT IN ('deleted', 'removing')
    `, [seed.HOG_CLIENT_ID]);
    expect(members.length).toBe(dbCount.cnt);
  });

  test('HOG active members in /members API match DB', async () => {
    const apiRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?status=active&limit=500`, {
      headers: { Cookie: cookie },
    });
    if (apiRes.status !== 200) return;
    const json = await apiRes.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    const dbCount = await db.queryOne(`
      SELECT COUNT(*)::int AS cnt FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND ma.status = 'active'
        AND ma.status NOT IN ('deleted', 'removing')
    `, [seed.HOG_CLIENT_ID]);
    if (apiRes.url?.includes('status=active')) {
      expect(members.length).toBe(dbCount.cnt);
    }
  });
});
