/**
 * e2e/api/api-webhook-delayed-start.spec.js
 * Verifies orderPurchased with future startDate and the orderStarted follow-up.
 * ~25 scenarios.
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

test.describe('API — Delayed-start plans (orderStarted)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('orderPurchased with future startDate → member_access created', async () => {
    const suffix      = `delayed-${Date.now()}`;
    const email       = seed.makeE2eEmail(suffix);
    const memberId    = seed.makeWixMemberId(suffix);
    const orderId     = `e2e-order-${suffix}`;
    const futureStart = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email, startDate: futureStart,
    }));

    const row = await waitFor(() => db.queryOne(`
      SELECT * FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]));
    expect(row, 'member_master not created for delayed-start plan').not.toBeNull();
  });

  test('orderStarted event_type normalized to plan.started in webhook_log', async () => {
    const suffix   = `started-norm-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    await postWebhook({
      ...seed.buildOrderStartedPayload({
        orderId: `e2e-order-${suffix}`,
        memberId,
        planId: seed.HOG_SOURCE_PLAN_IDS.individual,
      }),
      eventId,
    });

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('plan.started');
  });

  test('orderStarted with ACTIVE status fires grant', async () => {
    const suffix   = `started-grant-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const eventId  = `e2e-ev-${suffix}`;

    const body = JSON.stringify({
      ...seed.buildOrderStartedPayload({
        orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
      }),
      eventId,
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);

    const wl = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(wl?.event_type).toBe('plan.started');
  });

  test('orderStarted with DRAFT status dropped as plan.unpaid_order', async () => {
    const suffix   = `started-draft-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const body = JSON.stringify({
      eventType: 'wixPricingPlans.orderStarted',
      eventId,
      data: {
        entity: {
          _id:               `e2e-order-${suffix}`,
          planId:            seed.HOG_SOURCE_PLAN_IDS.individual,
          status:            'DRAFT',
          lastPaymentStatus: 'UNPAID',
          startDate:         new Date().toISOString(),
          buyer:             { memberId, contactId: memberId },
        },
      },
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('plan.unpaid_order');
  });

  test('effective_start captured on member_access_sources from orderStarted startDate', async () => {
    const suffix    = `started-effstart-${Date.now()}`;
    const email     = seed.makeE2eEmail(suffix);
    const memberId  = seed.makeWixMemberId(suffix);
    const orderId   = `e2e-order-${suffix}`;
    const startDate = new Date('2026-06-01T00:00:00Z').toISOString();

    await postWebhook(seed.buildOrderStartedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email, startDate,
    }));

    const row = await waitFor(async () => {
      const master = await db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      if (!master) return null;
      return db.queryOne(`
        SELECT mas.effective_start FROM member_access_sources mas
        JOIN member_access ma ON mas.access_id = ma.id
        WHERE ma.member_master_id = $1 AND mas.effective_start IS NOT NULL LIMIT 1
      `, [master.id]);
    }, 25_000);

    expect(row, 'effective_start not captured on member_access_sources').not.toBeNull();
    expect(new Date(row.effective_start).toISOString()).toBe(startDate);
  });
});
