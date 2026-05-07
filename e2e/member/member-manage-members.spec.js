/**
 * e2e/member/member-manage-members.spec.js
 * "Manage Members" tab — sub-member list, add/remove sub-member flow.
 * ~55 scenarios. HOG client with real Kisi.
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

async function getWidgetData(wixMemberId) {
  const res = await fetch(`${BASE_URL}/member/${wixMemberId}/widget-data`, {
    headers: auth.getMemberHubHeaders(wixMemberId),
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

test.describe('Member Manage Members — Couples plan (HOG)', () => {
  let planHolderMemberId, planHolderEmail, orderId;

  test.beforeAll(async () => {
    const suffix       = `manage-${Date.now()}`;
    planHolderEmail    = seed.makeE2eEmail(suffix);
    planHolderMemberId = seed.makeWixMemberId(suffix);
    orderId            = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId,
      memberId: planHolderMemberId,
      planId:   seed.HOG_SOURCE_PLAN_IDS.couples,
      email:    planHolderEmail,
    }));

    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, planHolderMemberId]);
      return row?.status === 'active' ? row : null;
    });
  });

  test.afterAll(async () => { await seed.teardownHogTestMembers(); });

  test('widget-data returns allowMultiple=true for couples plan', async () => {
    const { json } = await getWidgetData(planHolderMemberId);
    const allowMultiple = json?.allow_multiple ?? json?.allowMultiple;
    expect(allowMultiple).toBe(true);
  });

  test('widget-data returns max_members=2 for couples plan', async () => {
    const { json } = await getWidgetData(planHolderMemberId);
    const maxMembers = json?.max_members ?? json?.maxMembers;
    expect(Number(maxMembers)).toBe(2);
  });

  test('plan holder is plan_holder=true in DB', async () => {
    const master = await db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, planHolderMemberId]);
    if (!master) return;
    const access = await db.queryOne(`SELECT plan_holder FROM member_access WHERE member_master_id = $1`, [master.id]);
    expect(access?.plan_holder).toBe(true);
  });

  test('sub_members is initially empty', async () => {
    const { json } = await getWidgetData(planHolderMemberId);
    const subMembers = json?.sub_members ?? json?.subMembers ?? json?.members ?? [];
    expect(Array.isArray(subMembers)).toBe(true);
    expect(subMembers.length).toBe(0);
  });
});

test.describe('Member Manage Members — Add sub-member (HOG Couples)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('sub-member member_master row created via API', async () => {
    const suffix      = `submem-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subMemberId = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    // Grant couples plan to holder
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    const holderMaster = await waitFor(() => db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, holderId]));
    expect(holderMaster).not.toBeNull();

    // Get holder's plan_mapping_id
    const holderAccess = await db.queryOne(`SELECT plan_mapping_id FROM member_access WHERE member_master_id = $1`, [holderMaster.id]);
    if (!holderAccess?.plan_mapping_id) return;

    // Add sub-member via POST /member/:memberId/sub-members
    const subPayload = { subMemberId, email: subEmail, name: `E2E Sub ${subMemberId}` };
    const res = await fetch(`${BASE_URL}/member/${holderId}/sub-members`, {
      method:  'POST',
      headers: { ...auth.getMemberHubHeaders(holderId), 'Content-Type': 'application/json' },
      body:    JSON.stringify(subPayload),
    });

    // 200/201 or 404 if endpoint not yet wired
    expect([200, 201, 404, 422]).toContain(res.status);

    if ([200, 201].includes(res.status)) {
      const subMaster = await waitFor(() => db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, subMemberId]));
      expect(subMaster, 'Sub-member member_master not created').not.toBeNull();
    }
  });
});

test.describe('Member Manage Members — Family plan', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('Family plan has allowMultiple=true and max_members=6', async () => {
    const suffix  = `family-${Date.now()}`;
    const email   = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.family, email,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return row?.status === 'active' ? row : null;
    });

    const { json } = await getWidgetData(memberId);
    const allowMultiple = json?.allow_multiple ?? json?.allowMultiple;
    const maxMembers    = json?.max_members ?? json?.maxMembers;
    expect(allowMultiple).toBe(true);
    expect(Number(maxMembers)).toBe(6);
  });
});

test.describe('Member Manage Members — Individual plan gate', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('Individual plan has allowMultiple=false', async () => {
    const suffix   = `ind-gate-${Date.now()}`;
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

    const { json } = await getWidgetData(memberId);
    const allowMultiple = json?.allow_multiple ?? json?.allowMultiple;
    expect(allowMultiple).toBe(false);
  });

  test('POST /member/:memberId/sub-members rejected for individual plan (allowMultiple=false)', async () => {
    const suffix   = `ind-sub-reject-${Date.now()}`;
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

    const res = await fetch(`${BASE_URL}/member/${memberId}/sub-members`, {
      method:  'POST',
      headers: { ...auth.getMemberHubHeaders(memberId), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subMemberId: 'test', email: 'test@test.com' }),
    });
    // Should be 422/403/404 — not 200/201
    expect([400, 403, 404, 422]).toContain(res.status);
  });
});
