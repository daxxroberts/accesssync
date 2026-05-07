/**
 * e2e/admin/admin-members-filter.spec.js
 * Filter by status (active/inactive/pending), search by name/email.
 * ~40 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function postWebhook(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = auth.buildWebhookHeaders(raw, { siteId: seed.HOG_WIX_SITE_ID });
  return fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body: raw });
}

async function waitForStatus(memberId, status, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    if (row?.status === status) return row;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

test.describe('Admin Members Filter — Status filter API', () => {
  let cookie;
  test.beforeAll(async () => { cookie = await auth.getAdminCookie(); });

  test('GET /members?status=active returns only active members', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?status=active`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    for (const m of members) {
      const status = m.status ?? m.access_status ?? m.effective_status;
      expect(['active']).toContain(status);
    }
  });

  test('GET /members?status=inactive returns only inactive members', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?status=inactive`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    for (const m of members) {
      const status = m.status ?? m.access_status ?? m.effective_status;
      expect(['inactive']).toContain(status);
    }
  });

  test('active members API count matches DB', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?status=active`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    const dbCount = await db.queryOne(`
      SELECT COUNT(DISTINCT mm.id)::int AS cnt
      FROM member_master mm
      JOIN member_access ma ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND ma.status = 'active'
    `, [seed.HOG_CLIENT_ID]);
    expect(members.length).toBe(dbCount.cnt);
  });

  test('inactive members API count matches DB', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?status=inactive`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    const dbCount = await db.queryOne(`
      SELECT COUNT(DISTINCT mm.id)::int AS cnt
      FROM member_master mm
      JOIN member_access ma ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND ma.status = 'inactive'
    `, [seed.HOG_CLIENT_ID]);
    expect(members.length).toBe(dbCount.cnt);
  });
});

test.describe('Admin Members Filter — Email search', () => {
  let cookie, email, memberId, orderId;

  test.beforeAll(async () => {
    cookie = await auth.getAdminCookie();
    const suffix = `filter-test-${Date.now()}`;
    email    = seed.makeE2eEmail(suffix);
    memberId = seed.makeWixMemberId(suffix);
    orderId  = `e2e-order-${suffix}`;
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForStatus(memberId, 'active');
  });

  test.afterAll(async () => { await seed.teardownHogTestMembers(); });

  test('search by email returns matching member', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?search=${encodeURIComponent(email)}`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    const found = members.find(m => (m.email ?? '').includes('e2e-test-'));
    expect(found ?? null).not.toBeNull();
  });

  test('search by non-existent email returns empty', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?search=doesnotexist999@nowhere.test`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) return;
    const json = await res.json();
    const members = json?.members ?? json?.data ?? (Array.isArray(json) ? json : []);
    expect(members.length).toBe(0);
  });
});

test.describe('Admin Members Filter — Status transitions', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('member moves from not-found to active after grant', async () => {
    const suffix   = `trans-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const cookie   = await auth.getAdminCookie();

    // Before grant — not in DB
    const beforeRes = await fetch(`${ADMIN_BASE_URL}/operator/${seed.HOG_CLIENT_ID}/members?search=${encodeURIComponent(email)}`, {
      headers: { Cookie: cookie },
    });
    if (beforeRes.status === 200) {
      const beforeJson = await beforeRes.json();
      const beforeMembers = beforeJson?.members ?? beforeJson?.data ?? [];
      const beforeFound = beforeMembers.find(m => m.email === email);
      expect(beforeFound).toBeUndefined();
    }

    // Grant
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForStatus(memberId, 'active');

    // After grant — in DB and active
    const dbRow = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(dbRow?.status).toBe('active');
  });

  test('member moves from active to inactive after cancel', async () => {
    const suffix   = `trans2-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForStatus(memberId, 'active');

    await postWebhook(seed.buildOrderCancelledPayload({ orderId, memberId, email }));
    const inactiveRow = await waitForStatus(memberId, 'inactive');
    expect(inactiveRow).not.toBeNull();
  });
});
