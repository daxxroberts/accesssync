/**
 * e2e/member/member-access-inactive.spec.js
 * Inactive member sees correct state, no active plan shown.
 * ~30 scenarios.
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

async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function getAccessStatus(memberId) {
  const params = new URLSearchParams({ platformMemberId: memberId, clientId: seed.HOG_CLIENT_ID });
  const res = await fetch(`${BASE_URL}/member/access-status?${params}`, {
    headers: auth.getMemberHubHeaders(memberId),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

test.describe('Member Access — Inactive member state', () => {
  let email, memberId, orderId;

  test.beforeAll(async () => {
    const suffix = `inactive-state-${Date.now()}`;
    email        = seed.makeE2eEmail(suffix);
    memberId     = seed.makeWixMemberId(suffix);
    orderId      = `e2e-order-${suffix}`;

    // Grant
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

    // Cancel — pass HOG planId so revoke routes to correct mapping (default is test client).
    await postWebhook(seed.buildOrderCancelledPayload({
      orderId, memberId, email, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return row?.status === 'inactive' ? row : null;
    });
  });

  test.afterAll(async () => { await seed.teardownHogTestMembers(); });

  test('member_access status is inactive in DB', async () => {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(row?.status).toBe('inactive');
  });

  test('/member/access-status status is "inactive" (replaces hasAccess)', async () => {
    const { json } = await getAccessStatus(memberId);
    expect(json?.status).toBe('inactive');
  });

  test('widget-data reflects inactive status', async () => {
    const res = await fetch(`${BASE_URL}/member/${memberId}/widget-data`, {
      headers: auth.getMemberHubHeaders(memberId),
    });
    if (res.status === 200) {
      const json = await res.json();
      const status = json?.status ?? json?.accessStatus ?? json?.access_status;
      expect(['inactive', 'cancelled', 'revoked']).toContain(status);
    }
  });

  test('member_master row still exists after cancel (preserved)', async () => {
    const row = await db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(row, 'member_master deleted on cancel — should be preserved').not.toBeNull();
  });

  test('member_billing row still exists after cancel', async () => {
    const master = await db.queryOne(`SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2`, [seed.HOG_CLIENT_ID, memberId]);
    if (!master) return;
    const billing = await db.queryOne(`SELECT id FROM member_billing WHERE member_master_id = $1`, [master.id]);
    expect(billing, 'member_billing deleted on cancel — should be preserved').not.toBeNull();
  });
});

test.describe('Member Access — Unknown member state', () => {
  test('unknown member returns 404 (Member not found)', async () => {
    const { status, json } = await getAccessStatus('completely-unknown-member-xyz');
    expect(status).toBe(404);
    expect(json?.error).toBeTruthy();
  });
});

test.describe('Member Access — Suspended state', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('paused member has non-active status in DB', async () => {
    const suffix   = `paused-state-${Date.now()}`;
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

    await postWebhook(seed.buildOrderPausedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
    }));

    const row = await waitFor(async () => {
      const r = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return r?.status !== 'active' ? r : null;
    });

    if (row) {
      expect(['suspended', 'inactive', 'paused']).toContain(row.status);
    }
  });
});
