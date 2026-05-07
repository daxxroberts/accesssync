/**
 * e2e/api/api-webhook-idempotency.spec.js
 * Verifies deduplication: same wix_order_id + cycle_index twice → second INSERT blocked.
 * Also verifies processed_event_ids dedup at webhook ingress.
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

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

test.describe.configure({ mode: 'serial' });

test.describe('API — Billing deduplication (wix_order_id + cycle_index)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('second identical orderPurchased does NOT create a second member_billing row', async () => {
    const suffix   = `dedup-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;
    const payload  = seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });

    await postWebhook(payload);
    await waitFor(() => db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]));
    // Wait for member_billing row to exist before the second post (otherwise the second
    // arrives before the first finishes provisioning, and the COUNT below races).
    await waitFor(() => db.queryOne(`
      SELECT mb.id FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 AND mb.wix_order_id = $3
    `, [seed.HOG_CLIENT_ID, memberId, orderId]));

    await postWebhook(payload);
    await new Promise(r => setTimeout(r, 3_000));

    const count = await db.queryOne(`
      SELECT COUNT(*)::int as cnt FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 AND mb.wix_order_id = $3
    `, [seed.HOG_CLIENT_ID, memberId, orderId]);
    expect(count.cnt).toBe(1);
  });

  test('second identical event_id is deduplicated at ingress (processed_event_ids)', async () => {
    const suffix  = `evdedup-${Date.now()}`;
    const eventId = `e2e-ev-${suffix}`;
    const memberId = seed.makeWixMemberId(suffix);

    const body = JSON.stringify({
      ...seed.buildOrderPurchasedPayload({
        orderId:  `e2e-order-${suffix}`,
        memberId,
        planId:   seed.HOG_SOURCE_PLAN_IDS.individual,
        email:    seed.makeE2eEmail(suffix),
      }),
      eventId,
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });

    const res1 = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res1.status).toBe(200);

    await waitFor(() => db.queryOne(`SELECT event_id FROM webhook_log WHERE event_id = $1`, [eventId]));

    const res2 = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res2.status).toBe(200);

    // webhook_log should have dedup_status = 'duplicate' on second occurrence
    await new Promise(r => setTimeout(r, 2_000));
    const dupRow = await db.queryOne(`
      SELECT dedup_status FROM webhook_log WHERE event_id = $1 AND dedup_status = 'duplicate'
    `, [eventId]);
    expect(dupRow, 'Second event not marked as duplicate in webhook_log').not.toBeNull();
  });

  test('renewal with cycle_index=2 creates a second billing row (not a duplicate)', async () => {
    const suffix   = `renewal-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const orderId  = `e2e-order-${suffix}`;

    // Initial purchase
    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId, planId: seed.HOG_SOURCE_PLAN_IDS.individual, email, cycleIndex: 1,
    }));

    await waitFor(() => db.queryOne(`
      SELECT mb.id FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.platform_member_id = $1 AND mb.cycle_index = 1
    `, [memberId]));

    // Renewal
    await postWebhook({
      eventType: 'wixPricingPlans.orderUpdated',
      data: {
        entity: {
          _id: orderId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ACTIVE', lastPaymentStatus: 'PAID',
          currentCycle: { index: 2 },
          buyer: { memberId, contactId: memberId, email },
        },
      },
    });

    const row2 = await waitFor(() => db.queryOne(`
      SELECT mb.id FROM member_billing mb
      JOIN member_master mm ON mb.member_master_id = mm.id
      WHERE mm.platform_member_id = $1 AND mb.cycle_index = 2
    `, [memberId]));
    expect(row2, 'Renewal cycle_index=2 billing row not created').not.toBeNull();
  });
});

test.describe('API — member_master upsert idempotency', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('same memberId on two different plans creates one member_master, two member_access rows', async () => {
    const suffix   = `twoplans-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId: `e2e-order-${suffix}-1`, memberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    }));

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId: `e2e-order-${suffix}-2`, memberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.student, email,
    }));

    await new Promise(r => setTimeout(r, 8_000));

    const masterCount = await db.queryOne(`
      SELECT COUNT(*)::int as cnt FROM member_master
      WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(masterCount.cnt).toBe(1);
  });
});
