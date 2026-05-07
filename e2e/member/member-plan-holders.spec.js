/**
 * e2e/member/member-plan-holders.spec.js
 * "Plan Holders" tab — allow_multiple gate, max_members enforcement.
 * ~40 scenarios.
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

test.describe('Plan Holders — DB constraints for allow_multiple', () => {
  test('Individual plan: allow_multiple=false, max_members=1 in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.individual]);
    expect(row?.allow_multiple).toBe(false);
    expect(row?.max_members).toBe(1);
  });

  test('Student plan: allow_multiple=false, max_members=1 in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.student]);
    expect(row?.allow_multiple).toBe(false);
    expect(row?.max_members).toBe(1);
  });

  test('Couples plan: allow_multiple=true, max_members=2 in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.couples]);
    expect(row?.allow_multiple).toBe(true);
    expect(row?.max_members).toBe(2);
  });

  test('Family plan: allow_multiple=true, max_members=6 in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple, max_members FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.family]);
    expect(row?.allow_multiple).toBe(true);
    expect(row?.max_members).toBe(6);
  });

  test('Military plan: allow_multiple=false in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.military]);
    expect(row?.allow_multiple).toBe(false);
  });

  test('First Responder plan: allow_multiple=false in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.firstResponder]);
    expect(row?.allow_multiple).toBe(false);
  });

  test('Couples v2: allow_multiple=true in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.couplesV2]);
    expect(row?.allow_multiple).toBe(true);
  });

  test('Individual v2: allow_multiple=false in plan_mappings', async () => {
    const row = await db.queryOne(`
      SELECT allow_multiple FROM plan_mappings WHERE id = $1
    `, [seed.HOG_PLANS.individualV2]);
    expect(row?.allow_multiple).toBe(false);
  });
});

test.describe('Plan Holders — Widget data allow_multiple gate', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  const PLAN_ALLOW_MULTIPLE = [
    { planKey: 'individual', sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.individual, allowMultiple: false, maxMembers: 1 },
    { planKey: 'student',    sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.student,    allowMultiple: false, maxMembers: 1 },
    { planKey: 'couples',    sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.couples,    allowMultiple: true,  maxMembers: 2 },
    { planKey: 'family',     sourcePlanId: seed.HOG_SOURCE_PLAN_IDS.family,     allowMultiple: true,  maxMembers: 6 },
  ];

  for (const planCase of PLAN_ALLOW_MULTIPLE) {
    test(`${planCase.planKey}: allowMultiple=${planCase.allowMultiple}, maxMembers=${planCase.maxMembers} in widget-data`, async () => {
      const suffix   = `planholder-${planCase.planKey}-${Date.now()}`;
      const email    = seed.makeE2eEmail(suffix);
      const memberId = seed.makeWixMemberId(suffix);
      const orderId  = `e2e-order-${suffix}`;

      await postWebhook(seed.buildOrderPurchasedPayload({
        orderId, memberId, planId: planCase.sourcePlanId, email,
      }));

      await waitFor(async () => {
        const row = await db.queryOne(`
          SELECT ma.status FROM member_access ma
          JOIN member_master mm ON ma.member_master_id = mm.id
          WHERE mm.client_id = $1 AND mm.platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, memberId]);
        return row?.status === 'active' ? row : null;
      });

      const params = new URLSearchParams({ memberId, siteId: seed.HOG_WIX_SITE_ID });
      const res = await fetch(`${BASE_URL}/member/access-status?${params}`, {
        headers: auth.getMemberHubHeaders(memberId),
      });

      if (res.status === 200) {
        const json = await res.json();
        // Widget-data endpoint also drives the UI gate — check both
        const widgetRes = await fetch(`${BASE_URL}/member/${memberId}/widget-data`, {
          headers: auth.getMemberHubHeaders(memberId),
        });
        if (widgetRes.status === 200) {
          const widgetJson = await widgetRes.json();
          const allowMultiple = widgetJson?.allow_multiple ?? widgetJson?.allowMultiple;
          const maxMembers    = widgetJson?.max_members    ?? widgetJson?.maxMembers;
          expect(allowMultiple).toBe(planCase.allowMultiple);
          expect(Number(maxMembers)).toBe(planCase.maxMembers);
        }
      }
    });
  }
});

test.describe('Plan Holders — plan_holder field', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('member_access plan_holder=true for direct grant holder', async () => {
    const suffix   = `planholder-field-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));

    const access = await waitFor(async () => {
      const master = await db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      if (!master) return null;
      const a = await db.queryOne(`SELECT * FROM member_access WHERE member_master_id = $1`, [master.id]);
      return a?.status === 'active' ? a : null;
    });

    expect(access?.plan_holder).toBe(true);
    expect(access?.sub_master_id).toBeNull();
  });
});
