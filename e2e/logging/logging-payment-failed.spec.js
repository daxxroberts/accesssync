/**
 * e2e/logging/logging-payment-failed.spec.js
 * Verifies payment.failed (orderPaused) and payment.recovered (orderResumed)
 * paths produce correct log rows and member_access state changes.
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

async function waitForAccessStatus(memberId, status, timeoutMs = 20_000) {
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

test.describe.configure({ mode: 'serial' });

test.describe('Logging — payment.failed (orderPaused)', () => {
  test.afterEach(async () => {
    await seed.teardownHogTestMembers();
  });

  test('orderPaused normalizes to payment.failed in webhook_log', async () => {
    const suffix   = `paused-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const payload = seed.buildOrderPausedPayload({
      orderId: `e2e-order-${suffix}`,
      memberId,
      planId:  seed.HOG_SOURCE_PLAN_IDS.individual,
      eventId,
    });
    await postWebhook({ ...payload, eventId });

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not created for orderPaused').not.toBeNull();
    expect(row.event_type).toBe('payment.failed');
  });

  test('orderResumed normalizes to payment.recovered in webhook_log', async () => {
    const suffix   = `resumed-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const payload = {
      eventType: 'wixPricingPlans.orderResumed',
      eventId,
      data: {
        entity: {
          _id:    `e2e-order-${suffix}`,
          planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE',
          buyer:  { memberId, contactId: memberId },
        },
      },
    };
    await postWebhook({ ...payload, eventId });

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not created for orderResumed').not.toBeNull();
    expect(row.event_type).toBe('payment.recovered');
  });

  test('payment.failed sets member_access status to suspended', async () => {
    const suffix   = `suspend-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    // Grant first
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForAccessStatus(memberId, 'active');

    // Pause
    await postWebhook(seed.buildOrderPausedPayload({ orderId, memberId }));

    // Status should be suspended or inactive depending on implementation
    const deadline = Date.now() + 15_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      if (row?.status && row.status !== 'active') break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(row, 'member_access not updated after payment.failed').not.toBeNull();
    expect(['suspended', 'inactive']).toContain(row.status);
  });

  test('webhook_log has hmac_status=accepted for orderPaused', async () => {
    const suffix   = `paused-hmac-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    await postWebhook({
      eventType: 'wixPricingPlans.orderPaused',
      eventId,
      data: {
        entity: {
          _id: `e2e-order-${suffix}`,
          planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'PAUSED',
          buyer: { memberId, contactId: memberId },
        },
      },
    });

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT hmac_status FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not found').not.toBeNull();
    expect(row.hmac_status).toBe('accepted');
  });
});

test.describe('Logging — payment.failed in v_trace_timeline', () => {
  test.afterEach(async () => {
    await seed.teardownHogTestMembers();
  });

  test('payment.failed event has trace_id and appears in v_trace_timeline', async () => {
    const suffix   = `pf-trace-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const eventId  = `e2e-ev-${suffix}`;

    // Grant
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForAccessStatus(memberId, 'active');

    // Pause
    await postWebhook({ ...seed.buildOrderPausedPayload({ orderId, memberId }), eventId });

    const deadline = Date.now() + 8_000;
    let traceId = null;
    while (Date.now() < deadline) {
      const wl = await db.queryOne(`SELECT trace_id FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (wl?.trace_id) { traceId = wl.trace_id; break; }
      await new Promise(r => setTimeout(r, 300));
    }
    expect(traceId, 'No trace_id on payment.failed webhook_log row').toBeTruthy();

    const deadline2 = Date.now() + 15_000;
    let traceRow = null;
    while (Date.now() < deadline2) {
      traceRow = await db.queryOne(`
        SELECT * FROM v_trace_timeline WHERE trace_id = $1 LIMIT 1
      `, [traceId]);
      if (traceRow) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(traceRow, 'payment.failed not visible in v_trace_timeline').not.toBeNull();
  });
});
