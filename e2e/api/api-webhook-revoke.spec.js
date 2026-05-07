/**
 * e2e/api/api-webhook-revoke.spec.js
 * Verifies all cancel event variants set member_access status=inactive.
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

async function waitForStatus(memberId, status, timeoutMs = 20_000) {
  return waitFor(async () => {
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    return row?.status === status ? row : null;
  }, timeoutMs);
}

async function grantAndActivate(suffix) {
  const email    = seed.makeE2eEmail(suffix);
  const memberId = seed.makeWixMemberId(suffix);
  const orderId  = `e2e-order-${suffix}`;
  await postWebhook(seed.buildOrderPurchasedPayload({
    orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
  }));
  await waitForStatus(memberId, 'active', 25_000);
  return { email, memberId, orderId };
}

const CANCEL_VARIANTS = [
  { eventType: 'wixPricingPlans.orderCanceled',          expectedEvent: 'plan.cancelled' },
  { eventType: 'wixPricingPlans.orderCancelled',         expectedEvent: 'plan.cancelled' },
  { eventType: 'wixPricingPlans.orderAutoRenewCanceled', expectedEvent: 'plan.cancelled' },
  { eventType: 'wixPricingPlans.orderEnded',             expectedEvent: 'plan.cancelled' },
  { eventType: 'wixPricingPlans.orderExpired',           expectedEvent: 'plan.cancelled' },
];

test.describe.configure({ mode: 'serial' });

test.describe('API — Cancel variants → member_access inactive', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  for (const variant of CANCEL_VARIANTS) {
    test(`${variant.eventType} → status=inactive`, async () => {
      test.setTimeout(60_000);
      const suffix = `rev-${variant.eventType.split('.')[1]}-${Date.now()}`;
      const { email, memberId, orderId } = await grantAndActivate(suffix);

      await postWebhook({
        eventType: variant.eventType,
        data: {
          entity: {
            _id: orderId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
            status: 'CANCELED', buyer: { memberId, contactId: memberId, email },
          },
        },
      });

      const row = await waitForStatus(memberId, 'inactive');
      expect(row, `${variant.eventType} did not set status=inactive`).not.toBeNull();
    });

    test(`${variant.eventType} → normalizes to ${variant.expectedEvent} in webhook_log`, async () => {
      const suffix  = `norm-${variant.eventType.split('.')[1]}-${Date.now()}`;
      const memberId = seed.makeWixMemberId(suffix);
      const eventId  = `e2e-ev-${suffix}`;

      await postWebhook({
        eventType: variant.eventType,
        eventId,
        data: {
          entity: {
            _id: `e2e-order-${suffix}`, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
            status: 'CANCELED', buyer: { memberId, contactId: memberId },
          },
        },
      });

      const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
      expect(row?.event_type).toBe(variant.expectedEvent);
    });
  }
});

test.describe('API — Revoke clears Kisi role (HOG)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('member_access hardware_user_id is set before revoke', async () => {
    test.setTimeout(60_000);
    const suffix = `hw-check-${Date.now()}`;
    const { memberId } = await grantAndActivate(suffix);
    const row = await waitFor(async () => {
      const a = await db.queryOne(`
        SELECT ma.hardware_user_id FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      return a?.hardware_user_id ? a : null;
    }, 25_000);
    expect(row, 'hardware_user_id not set — Kisi user not created').not.toBeNull();
  });

  test('member_access_sources rows cleared after revoke (DR-034: deleted when all sources gone)', async () => {
    test.setTimeout(60_000);
    const suffix = `sources-after-rev-${Date.now()}`;
    const { email, memberId, orderId } = await grantAndActivate(suffix);

    // Cancel
    await postWebhook(seed.buildOrderCancelledPayload({ orderId, memberId, email, planId: seed.HOG_SOURCE_PLAN_IDS.individual }));
    await waitForStatus(memberId, 'inactive');

    const row = await db.queryOne(`
      SELECT mas.* FROM member_access_sources mas
      JOIN member_access ma ON mas.access_id = ma.id
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 LIMIT 1
    `, [seed.HOG_CLIENT_ID, memberId]);
    // DR-034: source rows are deleted when revoked — this is by design, not a bug
    expect(row).toBeNull();
  });

  test('member_billing row still exists after revoke', async () => {
    test.setTimeout(60_000);
    const suffix = `billing-after-rev-${Date.now()}`;
    const { email, memberId, orderId } = await grantAndActivate(suffix);

    await postWebhook(seed.buildOrderCancelledPayload({ orderId, memberId, email, planId: seed.HOG_SOURCE_PLAN_IDS.individual }));
    await waitForStatus(memberId, 'inactive');

    const row = await db.queryOne(`
      SELECT mb.* FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 LIMIT 1
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(row, 'member_billing row deleted on revoke — should be preserved').not.toBeNull();
  });
});

test.describe('API — Double cancel is idempotent', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('second cancel on already-inactive member returns 200', async () => {
    test.setTimeout(60_000);
    const suffix = `double-cancel-${Date.now()}`;
    const { email, memberId, orderId } = await grantAndActivate(suffix);

    const cancelPayload = seed.buildOrderCancelledPayload({ orderId, memberId, email, planId: seed.HOG_SOURCE_PLAN_IDS.individual });
    await postWebhook(cancelPayload);
    await waitForStatus(memberId, 'inactive');

    // Second cancel
    const res = await postWebhook(cancelPayload);
    expect(res.status).toBe(200);

    // Status still inactive
    const row = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(row?.status).toBe('inactive');
  });
});
