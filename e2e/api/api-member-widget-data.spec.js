/**
 * e2e/api/api-member-widget-data.spec.js
 * Verifies the Member Hub widget-data endpoint that powers the Wix iframe.
 *
 * Endpoint: GET /member/:memberId/widget-data?clientId=Y
 *   - Lives on Admin Hub (NOT Core Engine).
 *   - URL :memberId param = platform_member_id (Wix Member ID), per the live UI.
 *   - No auth — this is the iframe's anonymous read; security via inability to
 *     guess valid (memberId, clientId) pairs.
 *
 * Response shape (from admin/routes/multi-member.js):
 *   {
 *     holder: { id, platformMemberId, accessStatus, provisionedAt, firstName, lastName, email, phone },
 *     plans:  [ { id, sourcePlanId, planName, allowMultiple, maxMembers, doorName, holderHasSlot } ],
 *     subMembers: [ { id, memberMasterId, platformMemberId, firstName, lastName, email, phone, status, planMappingId, provisionedAt } ]
 *   }
 *
 * Note: only plans where allow_multiple=true appear in plans[]. Individual plans return plans=[].
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://accesssync-admin.up.railway.app';
const CORE_BASE_URL  = process.env.BASE_URL       || 'https://accesssync-production.up.railway.app';

async function getWidgetData(wixMemberId, clientId) {
  const params = new URLSearchParams({ clientId: clientId || seed.HOG_CLIENT_ID });
  const res = await fetch(
    `${ADMIN_BASE_URL}/member/${encodeURIComponent(wixMemberId)}/widget-data?${params}`,
    { cache: 'no-store' }
  );
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function postWebhook(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = auth.buildWebhookHeaders(raw, { siteId: seed.HOG_WIX_SITE_ID });
  return fetch(`${CORE_BASE_URL}/webhooks/wix`, { method: 'POST', headers, body: raw });
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

async function waitForActive(memberId, timeoutMs = 25_000) {
  return waitFor(async () => {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    return row?.status === 'active' ? row : null;
  }, timeoutMs);
}

test.describe.configure({ mode: 'serial' });

test.describe('API — /member/:memberId/widget-data — basic contract', () => {
  test('clientId is required (400 without it)', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/member/test-member/widget-data`);
    expect(res.status).toBe(400);
  });

  test('unknown member returns 404', async () => {
    const { status } = await getWidgetData('unknown-widget-member-00000');
    expect(status).toBe(404);
  });
});

test.describe('API — widget-data for active individual plan holder (HOG)', () => {
  let wixMemberId, orderId;

  test.beforeEach(async () => {
    const suffix = `widget-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    wixMemberId  = seed.makeWixMemberId(suffix);
    orderId      = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email: seed.makeE2eEmail(suffix),
    }));
    await waitForActive(wixMemberId);
  });

  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('returns 200', async () => {
    const { status } = await getWidgetData(wixMemberId);
    expect(status).toBe(200);
  });

  test('holder.accessStatus is active', async () => {
    const { json } = await getWidgetData(wixMemberId);
    expect(json?.holder?.accessStatus).toBe('active');
  });

  test('holder.platformMemberId echoes the request', async () => {
    const { json } = await getWidgetData(wixMemberId);
    expect(json?.holder?.platformMemberId).toBe(wixMemberId);
  });

  test('plans[] is the universe of multi-plans for the client (not gated by what holder owns)', async () => {
    // Per multi-member.js: plans[] returns ALL active plans where allow_multiple=true
    // for the client — the universe of multi-plans the operator offers. Per-holder
    // gating happens via plans[].holderHasSlot, not by filtering the array.
    const { json } = await getWidgetData(wixMemberId);
    expect(Array.isArray(json?.plans)).toBe(true);
    // Every entry must be allow_multiple=true (this is the filter the handler applies).
    for (const p of json.plans) {
      expect(p.allowMultiple).toBe(true);
    }
    // For an individual plan holder, none of the multi-plans should show holderHasSlot=true.
    const ownsAnyMulti = json.plans.some(p => p.holderHasSlot === true);
    expect(ownsAnyMulti).toBe(false);
  });

  test('subMembers[] is empty for new individual plan holder', async () => {
    const { json } = await getWidgetData(wixMemberId);
    expect(Array.isArray(json?.subMembers)).toBe(true);
    expect(json.subMembers.length).toBe(0);
  });
});

test.describe('API — widget-data for couples plan holder (HOG)', () => {
  let wixMemberId, orderId;

  test.beforeEach(async () => {
    const suffix = `widget-couples-${Date.now()}`;
    wixMemberId  = seed.makeWixMemberId(suffix);
    orderId      = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: seed.makeE2eEmail(suffix),
    }));
    await waitForActive(wixMemberId);
  });

  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('plans[] includes the couples plan with allowMultiple=true', async () => {
    const { json } = await getWidgetData(wixMemberId);
    const couplesPlan = json?.plans?.find(p => p.allowMultiple === true);
    expect(couplesPlan).toBeTruthy();
  });

  test('plans[] couples entry has maxMembers >= 2', async () => {
    const { json } = await getWidgetData(wixMemberId);
    const couplesPlan = json?.plans?.find(p => p.allowMultiple === true);
    expect(Number(couplesPlan?.maxMembers)).toBeGreaterThanOrEqual(2);
  });

  test('plans[] entry has sourcePlanId matching the HOG couples plan', async () => {
    const { json } = await getWidgetData(wixMemberId);
    const couplesPlan = json?.plans?.find(p => p.sourcePlanId === seed.HOG_SOURCE_PLAN_IDS.couples);
    expect(couplesPlan).toBeTruthy();
    expect(couplesPlan.planName).toBeTruthy();
  });

  test('subMembers[] starts empty for fresh couples plan', async () => {
    const { json } = await getWidgetData(wixMemberId);
    expect(Array.isArray(json?.subMembers)).toBe(true);
    // No sub-members added yet via the multi-member POST endpoint.
    expect(json.subMembers.length).toBe(0);
  });
});

test.describe('API — widget-data holder identity fields', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('holder.id is the AccessSync member_master.id (UUID)', async () => {
    const suffix    = `widget-id-${Date.now()}`;
    const memberId  = seed.makeWixMemberId(suffix);
    const orderId   = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
      email: seed.makeE2eEmail(suffix),
    }));
    await waitForActive(memberId);

    const { json } = await getWidgetData(memberId);
    // holder.id should be a UUID (AccessSync internal id), not the Wix Member ID.
    expect(json?.holder?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(json.holder.id).not.toBe(memberId);
  });

  test('holder.email is populated from the webhook payload', async () => {
    const suffix    = `widget-email-${Date.now()}`;
    const memberId  = seed.makeWixMemberId(suffix);
    const orderId   = `e2e-order-${suffix}`;
    const email     = seed.makeE2eEmail(suffix);

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForActive(memberId);

    const { json } = await getWidgetData(memberId);
    expect(json?.holder?.email).toBe(email);
  });
});
