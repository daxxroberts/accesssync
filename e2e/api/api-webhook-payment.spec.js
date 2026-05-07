/**
 * e2e/api/api-webhook-payment.spec.js
 * Verifies orderPaused (payment.failed) and orderResumed (payment.recovered) paths.
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

async function waitForStatus(memberId, status) {
  return waitFor(async () => {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    return row?.status === status ? row : null;
  });
}

test.describe('API — orderPaused (payment.failed)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('orderPaused returns 200', async () => {
    const suffix   = `paused-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const res = await postWebhook(seed.buildOrderPausedPayload({
      orderId: `e2e-order-${suffix}`, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
    }));
    expect(res.status).toBe(200);
  });

  test('orderPaused logged as payment.failed in webhook_log', async () => {
    const suffix   = `paused-log-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;
    await postWebhook({ ...seed.buildOrderPausedPayload({
      orderId: `e2e-order-${suffix}`, memberId,
    }), eventId });

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('payment.failed');
  });

  test('suspend after active: member_access status changes from active', async () => {
    const suffix   = `suspend-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    // Grant
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForStatus(memberId, 'active');

    // Pause
    await postWebhook(seed.buildOrderPausedPayload({ orderId, memberId }));

    // Status should change
    const deadline = Date.now() + 20_000;
    let status = 'active';
    while (Date.now() < deadline) {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      if (row?.status !== 'active') { status = row?.status; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(status).not.toBe('active');
  });
});

test.describe('API — orderResumed (payment.recovered)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('orderResumed returns 200', async () => {
    const suffix   = `resumed-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const res = await postWebhook({
      eventType: 'wixPricingPlans.orderResumed',
      data: {
        entity: {
          _id: `e2e-order-${suffix}`, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE', lastPaymentStatus: 'PAID',
          buyer: { memberId, contactId: memberId },
        },
      },
    });
    expect(res.status).toBe(200);
  });

  test('orderResumed logged as payment.recovered in webhook_log', async () => {
    const suffix   = `resumed-log-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;
    await postWebhook({
      eventType: 'wixPricingPlans.orderResumed',
      eventId,
      data: {
        entity: {
          _id: `e2e-order-${suffix}`, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE', lastPaymentStatus: 'PAID',
          buyer: { memberId, contactId: memberId },
        },
      },
    });

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('payment.recovered');
  });

  test('suspend then resume: member_access returns to active', async () => {
    const suffix   = `suspend-resume-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    // Grant
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForStatus(memberId, 'active');

    // Suspend
    await postWebhook(seed.buildOrderPausedPayload({ orderId, memberId }));
    await waitFor(async () => {
      const r = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return r?.status !== 'active' ? r : null;
    });

    // Resume
    await postWebhook({
      eventType: 'wixPricingPlans.orderResumed',
      data: {
        entity: {
          _id: orderId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE', lastPaymentStatus: 'PAID',
          buyer: { memberId, contactId: memberId, email },
        },
      },
    });

    const row = await waitForStatus(memberId, 'active');
    expect(row, 'member_access did not return to active after orderResumed').not.toBeNull();
  });
});
