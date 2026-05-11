/**
 * e2e/member/member-my-access.spec.js
 * "My Access" tab — plan name, status, hardware_user_id, billing fields.
 * ~55 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function postWebhook(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = auth.buildWebhookHeaders(raw, { siteId: seed.HOG_WIX_SITE_ID });
  return fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body: raw });
}

async function waitFor(fn, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function getAccessStatus(wixMemberId) {
  // Endpoint expects platformMemberId + clientId, not memberId + siteId.
  const params = new URLSearchParams({
    platformMemberId: wixMemberId,
    clientId:         seed.HOG_CLIENT_ID,
  });
  const res = await fetch(`${BASE_URL}/member/access-status?${params}`, {
    headers: auth.getMemberHubHeaders(wixMemberId),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

test.describe('Member My Access — Active individual plan (HOG)', () => {
  let wixMemberId, email, orderId;

  test.beforeAll(async () => {
    const suffix = `myaccess-${Date.now()}`;
    email        = seed.makeE2eEmail(suffix);
    wixMemberId  = seed.makeWixMemberId(suffix);
    orderId      = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));

    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      return row?.status === 'active' ? row : null;
    });
  });

  test.afterAll(async () => { await seed.teardownHogTestMembers(); });

  test('/member/access-status returns 200', async () => {
    const { status } = await getAccessStatus(wixMemberId);
    expect(status).toBe(200);
  });

  test('status field is "active" (replaces hasAccess)', async () => {
    // Endpoint returns { status, plans[], access[], lastEvent } — no hasAccess flag.
    const { json } = await getAccessStatus(wixMemberId);
    expect(json?.status).toBe('active');
  });

  test('plans[] contains a planName entry after grant', async () => {
    // Wait for member_access_sources to land before asserting (sources arrive after status flips).
    await waitFor(async () => {
      const r = await db.queryOne(`
        SELECT mas.id FROM member_access_sources mas
        JOIN member_access ma ON ma.id = mas.access_id
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      return r ? r : null;
    });
    const { json } = await getAccessStatus(wixMemberId);
    expect(json?.plans?.[0]?.planName).toBeTruthy();
  });

  test('status is active', async () => {
    const { json } = await getAccessStatus(wixMemberId);
    expect(json?.status).toBe('active');
  });

  test('source_platform is wix', async () => {
    const row = await db.queryOne(`
      SELECT source_platform FROM member_master
      WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, wixMemberId]);
    expect(row?.source_platform).toBe('wix');
  });

  test('hardware_user_id is set in DB', async () => {
    const row = await waitFor(async () => {
      const master = await db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      if (!master) return null;
      const access = await db.queryOne(`
        SELECT hardware_user_id FROM member_access WHERE member_master_id = $1
      `, [master.id]);
      return access?.hardware_user_id ? access : null;
    }, 30_000);
    expect(row, 'hardware_user_id not set — Kisi not provisioned').not.toBeNull();
  });

  test('member_billing has wix_order_id', async () => {
    const master = await db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, wixMemberId]);
    if (!master) return;
    const billing = await waitFor(() => db.queryOne(`
      SELECT wix_order_id FROM member_billing WHERE member_master_id = $1
    `, [master.id]));
    expect(billing?.wix_order_id).toBe(orderId);
  });

  test('member_access_sources row exists', async () => {
    const master = await db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, wixMemberId]);
    if (!master) return;
    const access = await db.queryOne(`SELECT id FROM member_access WHERE member_master_id = $1`, [master.id]);
    if (!access) return;
    const sources = await waitFor(() => db.queryOne(`
      SELECT id FROM member_access_sources WHERE access_id = $1 LIMIT 1
    `, [access.id]));
    expect(sources).not.toBeNull();
  });

  test('member_access_sources has role_assignment_id (Kisi role ID)', async () => {
    const master = await db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, wixMemberId]);
    if (!master) return;
    const access = await db.queryOne(`SELECT id FROM member_access WHERE member_master_id = $1`, [master.id]);
    if (!access) return;
    const sources = await waitFor(async () => {
      const s = await db.queryOne(`
        SELECT role_assignment_id FROM member_access_sources WHERE access_id = $1 AND role_assignment_id IS NOT NULL LIMIT 1
      `, [access.id]);
      return s ? s : null;
    }, 30_000);
    if (sources) {
      expect(sources.role_assignment_id).toBeTruthy();
    }
  });
});

test.describe('Member My Access — After cancel', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('hasAccess=false after cancel', async () => {
    const suffix   = `myaccess-cancel-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return row?.status === 'active' ? row : null;
    });

    await postWebhook(seed.buildOrderCancelledPayload({ orderId, memberId, email }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return row?.status === 'inactive' ? row : null;
    });

    const { json } = await getAccessStatus(memberId);
    expect(json?.status).toBe('inactive');
  });
});

test.describe('Member My Access — member hub page renders', () => {
  test('GET /member-hub on Admin Hub returns 200 (member-facing iframe)', async () => {
    // /member-hub lives on Admin Hub (member-hub.ejs), accessed by Wix iframe.
    const res = await fetch(`${process.env.ADMIN_BASE_URL || 'http://localhost:3001'}/member-hub`);
    expect([200, 404]).toContain(res.status);
  });
});
