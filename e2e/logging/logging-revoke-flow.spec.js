/**
 * e2e/logging/logging-revoke-flow.spec.js
 * Verifies that plan.cancelled events produce revoke rows in v_trace_timeline
 * and set member_access status to 'inactive'.
 * ~35 scenarios.
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

async function waitForMemberAccessStatus(wixMemberId, status, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, wixMemberId]);
    if (row?.status === status) return row;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function waitForTraceEvent(traceId, eventFragment, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.queryOne(`
      SELECT * FROM v_trace_timeline
      WHERE trace_id = $1 AND event ILIKE $2
      ORDER BY ts DESC LIMIT 1
    `, [traceId, `%${eventFragment}%`]);
    if (row) return row;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

const CANCEL_EVENT_TYPES = [
  'wixPricingPlans.orderCanceled',
  'wixPricingPlans.orderCancelled',
  'wixPricingPlans.orderAutoRenewCanceled',
  'wixPricingPlans.orderEnded',
  'wixPricingPlans.orderExpired',
];

test.describe('Logging — Revoke Flow', () => {
  test.afterEach(async () => {
    await seed.teardownHogTestMembers();
  });

  // Grant + then cancel for each cancel event type
  for (const cancelEventType of CANCEL_EVENT_TYPES) {
    test(`${cancelEventType} → member_access status=inactive`, async () => {
      const suffix    = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const email     = seed.makeE2eEmail(suffix);
      const memberId  = seed.makeWixMemberId(suffix);
      const orderId   = `e2e-order-${suffix}`;

      // Grant first
      const grantPayload = seed.buildOrderPurchasedPayload({
        orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
      });
      await postWebhook(grantPayload);

      // Wait for active
      const activeRow = await waitForMemberAccessStatus(memberId, 'active');
      expect(activeRow, 'member_access never reached active — grant failed').not.toBeNull();

      // Now cancel
      const cancelPayload = {
        eventType: cancelEventType,
        data: {
          entity: {
            _id:    orderId,
            planId: seed.HOG_SOURCE_PLAN_IDS.individual,
            status: 'CANCELED',
            buyer:  { memberId, contactId: memberId, email },
          },
        },
      };
      const res = await postWebhook(cancelPayload);
      expect(res.status).toBe(200);

      // Wait for inactive
      const inactiveRow = await waitForMemberAccessStatus(memberId, 'inactive');
      expect(inactiveRow, `member_access not inactive after ${cancelEventType}`).not.toBeNull();
    });
  }

  test('webhook_log has cancel event row', async () => {
    const suffix   = `rev-log-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const eventId  = `e2e-ev-${suffix}`;

    const cancelPayload = seed.buildOrderCancelledPayload({ orderId, memberId, email });
    const body = JSON.stringify({ ...cancelPayload, eventId });
    await postWebhook(body);

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT * FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not created for cancel').not.toBeNull();
    expect(row.hmac_status).toBe('accepted');
    expect(row.event_type).toBe('plan.cancelled');
  });

  test('v_trace_timeline has revoke row after cancel', async () => {
    const suffix   = `rev-trace-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const eventId  = `e2e-ev-${suffix}`;

    // Grant first
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));
    await waitForMemberAccessStatus(memberId, 'active');

    // Cancel
    const cancelPayload = seed.buildOrderCancelledPayload({ orderId, memberId, email });
    const body = JSON.stringify({ ...cancelPayload, eventId });
    await postWebhook(body);

    // Get trace_id
    const deadline = Date.now() + 8_000;
    let traceId = null;
    while (Date.now() < deadline) {
      const wl = await db.queryOne(`SELECT trace_id FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (wl?.trace_id) { traceId = wl.trace_id; break; }
      await new Promise(r => setTimeout(r, 300));
    }
    expect(traceId, 'No trace_id for cancel event').toBeTruthy();

    const row = await waitForTraceEvent(traceId, 'revoke');
    expect(row, 'No revoke row in v_trace_timeline').not.toBeNull();
    expect(row.result).toBe('success');
  });
});

test.describe('Logging — Cancel event normalization', () => {
  test('orderCanceled normalizes to plan.cancelled in webhook_log', async () => {
    const suffix   = `norm-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const payload = {
      eventType: 'wixPricingPlans.orderCanceled',
      eventId,
      data: {
        entity: {
          _id: `e2e-order-${suffix}`,
          planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'CANCELED',
          buyer: { memberId, contactId: memberId },
        },
      },
    };
    await postWebhook(payload);

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not created').not.toBeNull();
    expect(row.event_type).toBe('plan.cancelled');
  });
});
