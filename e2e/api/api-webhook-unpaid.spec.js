/**
 * e2e/api/api-webhook-unpaid.spec.js
 * Verifies DRAFT/UNPAID orders are dropped (rewritten to plan.unpaid_order).
 * No grant fires. ~30 scenarios.
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

async function waitFor(fn, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

const UNPAID_CASES = [
  { status: 'DRAFT',           paymentStatus: 'UNPAID' },
  { status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' },
  { status: 'PENDING_PAYMENT', paymentStatus: 'PENDING' },
  { status: 'DRAFT',           paymentStatus: null },
];

test.describe('API — Unpaid order dropped (payment guard)', () => {
  for (const { status, paymentStatus } of UNPAID_CASES) {
    test(`status=${status} lastPaymentStatus=${paymentStatus} → plan.unpaid_order`, async () => {
      const suffix   = `unpaid-${status}-${Date.now()}`;
      const memberId = seed.makeWixMemberId(suffix);
      const eventId  = `e2e-ev-${suffix}`;

      const body = JSON.stringify({
        eventType: 'wixPricingPlans.orderPurchased',
        eventId,
        data: {
          entity: {
            _id:               `e2e-order-${suffix}`,
            planId:            seed.HOG_SOURCE_PLAN_IDS.individual,
            status,
            lastPaymentStatus: paymentStatus,
            buyer:             { memberId, contactId: memberId, email: seed.makeE2eEmail(suffix) },
          },
        },
      });
      const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
      const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
      expect(row, 'webhook_log row not created').not.toBeNull();
      expect(row.event_type).toBe('plan.unpaid_order');
    });

    test(`status=${status} lastPaymentStatus=${paymentStatus} → NO member_master created`, async () => {
      const suffix   = `unpaid-noop-${status}-${Date.now()}`;
      const memberId = seed.makeWixMemberId(suffix);

      const body = JSON.stringify({
        eventType: 'wixPricingPlans.orderPurchased',
        data: {
          entity: {
            _id:               `e2e-order-${suffix}`,
            planId:            seed.HOG_SOURCE_PLAN_IDS.individual,
            status,
            lastPaymentStatus: paymentStatus,
            buyer:             { memberId, contactId: memberId },
          },
        },
      });
      const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
      await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

      await new Promise(r => setTimeout(r, 5_000));
      const master = await db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, memberId]);
      expect(master, `member_master created for unpaid status=${status}`).toBeNull();
    });
  }
});

test.describe('API — TRIAL payment status is allowed', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('status=ACTIVE lastPaymentStatus=TRIAL → grant fires (plan.purchased)', async () => {
    const suffix   = `trial-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const body = JSON.stringify({
      eventType: 'wixPricingPlans.orderPurchased',
      eventId,
      data: {
        entity: {
          _id:               `e2e-order-${suffix}`,
          planId:            seed.HOG_SOURCE_PLAN_IDS.individual,
          status:            'ACTIVE',
          lastPaymentStatus: 'TRIAL',
          buyer:             { memberId, contactId: memberId, email },
        },
      },
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('plan.purchased');
  });

  test('status=ACTIVE lastPaymentStatus=null (free plan) → grant fires', async () => {
    const suffix   = `free-${Date.now()}`;
    const email    = seed.makeE2eEmail(suffix);
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    const body = JSON.stringify({
      eventType: 'wixPricingPlans.orderPurchased',
      eventId,
      data: {
        entity: {
          _id:               `e2e-order-${suffix}`,
          planId:            seed.HOG_SOURCE_PLAN_IDS.freeService,
          status:            'ACTIVE',
          lastPaymentStatus: null,
          buyer:             { memberId, contactId: memberId, email },
        },
      },
    });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row?.event_type).toBe('plan.purchased');
  });
});
