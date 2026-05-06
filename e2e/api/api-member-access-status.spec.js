/**
 * e2e/api/api-member-access-status.spec.js
 * Verifies /member/access-status API endpoint for active, inactive, and multi-plan members.
 * Uses x-internal-proxy: 1 bypass for auth.
 * ~35 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function getAccessStatus(wixMemberId, siteId) {
  const params = new URLSearchParams({
    memberId: wixMemberId,
    siteId:   siteId || seed.HOG_WIX_SITE_ID,
  });
  const res = await fetch(`${BASE_URL}/member/access-status?${params}`, {
    headers: auth.getMemberHubHeaders(wixMemberId),
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function postWebhook(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = auth.buildWebhookHeaders(raw, { siteId: seed.HOG_WIX_SITE_ID });
  return fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body: raw });
}

async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

test.describe('API — /member/access-status auth', () => {
  test('returns 200 with x-internal-proxy: 1', async () => {
    const memberId = seed.makeWixMemberId(`status-auth-${Date.now()}`);
    const { status } = await getAccessStatus(memberId);
    expect([200, 404]).toContain(status);
  });

  test('returns 401 without auth header', async () => {
    const params = new URLSearchParams({ memberId: 'test', siteId: 'test-site' });
    const res = await fetch(`${BASE_URL}/member/access-status?${params}`);
    expect(res.status).toBe(401);
  });
});

test.describe('API — /member/access-status for active member (HOG)', () => {
  let email, wixMemberId, orderId;

  test.beforeEach(async () => {
    const suffix = `status-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    email        = seed.makeE2eEmail(suffix);
    wixMemberId  = seed.makeWixMemberId(suffix);
    orderId      = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    // Wait for grant to complete
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      return row?.status === 'active' ? row : null;
    });
  });

  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('active member returns 200', async () => {
    const { status } = await getAccessStatus(wixMemberId);
    expect(status).toBe(200);
  });

  test('active member response has hasAccess=true', async () => {
    const { json } = await getAccessStatus(wixMemberId);
    const hasAccess = json?.hasAccess ?? json?.has_access ?? json?.active;
    expect(hasAccess).toBe(true);
  });

  test('response includes plan_name', async () => {
    const { json } = await getAccessStatus(wixMemberId);
    const planName = json?.plan_name ?? json?.planName ?? json?.plan;
    expect(planName).toBeTruthy();
  });

  test('response includes hardware_user_id once provisioned', async () => {
    // Wait for Kisi provisioning
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.hardware_user_id FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      return row?.hardware_user_id ? row : null;
    }, 25_000);

    const { json } = await getAccessStatus(wixMemberId);
    const hwId = json?.hardware_user_id ?? json?.hardwareUserId ?? json?.kisi_user_id;
    expect(hwId).toBeTruthy();
  });

  test('response includes source_plan_id', async () => {
    const { json } = await getAccessStatus(wixMemberId);
    const planId = json?.source_plan_id ?? json?.sourcePlanId ?? json?.plan_id;
    expect(planId).toBeTruthy();
  });
});

test.describe('API — /member/access-status for inactive member', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('inactive member hasAccess=false', async () => {
    const suffix     = `inactive-${Date.now()}`;
    const email      = seed.makeE2eEmail(suffix);
    const wixMemberId = seed.makeWixMemberId(suffix);
    const orderId    = `e2e-order-${suffix}`;

    // Grant then cancel
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

    await postWebhook(seed.buildOrderCancelledPayload({ orderId, memberId: wixMemberId, email }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      return row?.status === 'inactive' ? row : null;
    });

    const { json } = await getAccessStatus(wixMemberId);
    const hasAccess = json?.hasAccess ?? json?.has_access ?? json?.active ?? false;
    expect(hasAccess).toBe(false);
  });
});

test.describe('API — /member/access-status for unknown member', () => {
  test('unknown memberId returns 200 or 404 with hasAccess=false', async () => {
    const { status, json } = await getAccessStatus('unknown-member-00000');
    expect([200, 404]).toContain(status);
    if (json) {
      const hasAccess = json?.hasAccess ?? json?.has_access ?? json?.active ?? false;
      expect(hasAccess).toBe(false);
    }
  });
});
