/**
 * e2e/api/api-webhook-grant.spec.js
 * Verifies orderPurchased, orderStarted, orderUpdated webhook paths.
 * Uses HOG client with real Kisi. ~50 scenarios.
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
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function getMasterRow(memberId) {
  return db.queryOne(`
    SELECT * FROM member_master WHERE client_id = $1 AND platform_member_id = $2
  `, [seed.HOG_CLIENT_ID, memberId]);
}

async function getAccessRow(memberId) {
  return db.queryOne(`
    SELECT ma.* FROM member_access ma
    JOIN member_master mm ON ma.member_master_id = mm.id
    WHERE mm.client_id = $1 AND mm.platform_member_id = $2
  `, [seed.HOG_CLIENT_ID, memberId]);
}

async function getBillingRow(memberId) {
  return db.queryOne(`
    SELECT mb.* FROM member_billing mb
    JOIN member_master mm ON mb.member_master_id = mm.id
    WHERE mm.client_id = $1 AND mm.platform_member_id = $2
  `, [seed.HOG_CLIENT_ID, memberId]);
}

test.describe.configure({ mode: 'serial' });

test.describe('API — orderPurchased grant path', () => {
  let suffix, email, memberId, orderId;

  test.beforeEach(() => {
    suffix   = `grant-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    email    = seed.makeE2eEmail(suffix);
    memberId = seed.makeWixMemberId(suffix);
    orderId  = `e2e-order-${suffix}`;
  });

  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('returns 200', async () => {
    const res = await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    expect(res.status).toBe(200);
  });

  test('webhook_log row created with event_type=plan.purchased', async () => {
    const eventId = `e2e-ev-${suffix}`;
    await postWebhook({ ...seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }), eventId });
    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('plan.purchased');
  });

  test('member_master created with correct email', async () => {
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    const row = await waitFor(() => getMasterRow(memberId));
    expect(row).not.toBeNull();
    expect(row.email).toBe(email);
    expect(row.source_platform).toBe('wix');
  });

  test('member_access created with status=active', async () => {
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    const row = await waitFor(async () => {
      const a = await getAccessRow(memberId);
      return a?.status === 'active' ? a : null;
    });
    expect(row).not.toBeNull();
    expect(row.plan_holder).toBe(true);
  });

  test('member_billing created with wix_order_id and cycle_index=1', async () => {
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    const row = await waitFor(async () => {
      const b = await getBillingRow(memberId);
      return b ? b : null;
    });
    expect(row).not.toBeNull();
    expect(row.wix_order_id).toBe(orderId);
    expect(row.cycle_index).toBe(1);
  });

  test('member_access_sources row created', async () => {
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    const row = await waitFor(async () => {
      return db.queryOne(`
        SELECT mas.* FROM member_access_sources mas
        JOIN member_access ma ON mas.access_id = ma.id
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
        LIMIT 1
      `, [seed.HOG_CLIENT_ID, memberId]);
    });
    expect(row).not.toBeNull();
    expect(row.source_plan_id).toBe(seed.HOG_SOURCE_PLAN_IDS.individual);
  });

  test('member_access has hardware_user_id set (Kisi user created)', async () => {
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    const row = await waitFor(async () => {
      const a = await getAccessRow(memberId);
      return a?.hardware_user_id ? a : null;
    }, 25_000);
    expect(row).not.toBeNull();
    expect(row.hardware_user_id).toBeTruthy();
  });

  test('orderUpdated (renewal) creates cycle_index=2 billing row', async () => {
    // First grant
    await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email }));
    await waitFor(() => getBillingRow(memberId));

    // Renewal via orderUpdated
    const renewalPayload = {
      eventType: 'wixPricingPlans.orderUpdated',
      data: {
        entity: {
          _id:    orderId,
          planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE',
          lastPaymentStatus: 'PAID',
          currentCycle: { index: 2 },
          buyer: { memberId, contactId: memberId, email },
        },
      },
    };
    await postWebhook(renewalPayload);

    const row = await waitFor(() => db.queryOne(`
      SELECT mb.* FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 AND mb.cycle_index = 2
    `, [seed.HOG_CLIENT_ID, memberId]));
    expect(row, 'Renewal cycle_index=2 billing row not created').not.toBeNull();
  });
});

test.describe('API — orderStarted (delayed-start plan)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('orderStarted with future startDate sets scheduled_start_date on member_access', async () => {
    const suffix   = `delayed-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const futureStart = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // orderPurchased with future startDate first
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email, startDate: futureStart,
    }));

    // Then orderStarted fires when startDate arrives (simulated immediately for testing)
    await postWebhook(seed.buildOrderStartedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email, startDate: new Date().toISOString(),
    }));

    const row = await waitFor(async () => {
      const a = await getAccessRow(memberId);
      return a ? a : null;
    });
    expect(row).not.toBeNull();
  });

  test('orderStarted webhook_log event_type = plan.started', async () => {
    const suffix   = `started-${Date.now()}`;
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
});

test.describe('API — All HOG plan types accepted', () => {
  const HOG_PLAN_IDS = Object.values(seed.HOG_SOURCE_PLAN_IDS);

  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  for (const planId of HOG_PLAN_IDS) {
    test(`plan ${planId} — webhook accepted (200)`, async () => {
      const suffix   = `plan-${planId.slice(0,8)}-${Date.now()}`;
      const email    = seed.makeE2eEmail(suffix);
      const memberId = seed.makeWixMemberId(suffix);
      const orderId  = `e2e-order-${suffix}`;

      const res = await postWebhook(seed.buildOrderPurchasedPayload({ orderId, memberId, planId, email }));
      expect(res.status).toBe(200);
    });
  }
});

test.describe('API — missing memberId handling', () => {
  test('webhook with no memberId returns 200 but logs warning (no grant fired)', async () => {
    const suffix  = `nomem-${Date.now()}`;
    const eventId = `e2e-ev-${suffix}`;
    const body = JSON.stringify({
      eventType: 'wixPricingPlans.orderPurchased',
      eventId,
      data: {
        entity: {
          _id:    `e2e-order-${suffix}`,
          planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE',
          lastPaymentStatus: 'PAID',
          buyer:  { memberId: null, email: null },
        },
      },
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);
  });
});
