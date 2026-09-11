/**
 * e2e/api/api-webhook-revoke.spec.js
 * Verifies all cancel event variants set member_access status=inactive.
 * ~40 scenarios.
 *
 * Auto-renew hotfix (Phase 1, 2026-09-10): wixPricingPlans.orderAutoRenewCanceled
 * is NOT a cancel. The member only turned off auto-renew — the order stays ACTIVE
 * and paid until Wix fires orderEnded. adapters/wix/wix-adapter.js normalizes it
 * to the non-routable 'plan.autorenew_cancelled' (in neither list in
 * core/event-routing.js), so webhook-processor enqueues nothing and the member
 * keeps door access. It used to map to plan.cancelled, which revoked paid members
 * weeks early. It has its own describe block below and is no longer a
 * CANCEL_VARIANT.
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
  { eventType: 'wixPricingPlans.orderEnded',             expectedEvent: 'plan.cancelled' },
  { eventType: 'wixPricingPlans.orderExpired',           expectedEvent: 'plan.cancelled' },
];

// How long to watch for a revoke that must NOT happen. A real cancel reaches
// status=inactive well inside waitForStatus's 20s budget above, so a member
// still active after this window was not revoked by the webhook.
const NO_REVOKE_SETTLE_MS = 12_000;

// A realistic auto-renew-cancel payload: the order is still ACTIVE and PAID —
// Wix only records that it won't renew.
function buildAutoRenewCanceledPayload({ orderId, memberId, email, eventId }) {
  return {
    eventType: 'wixPricingPlans.orderAutoRenewCanceled',
    ...(eventId ? { eventId } : {}),
    data: {
      entity: {
        _id:               orderId,
        planId:            seed.HOG_SOURCE_PLAN_IDS.individual,
        status:            'ACTIVE',
        lastPaymentStatus: 'PAID',
        autoRenewCanceled: true,
        buyer: { memberId, contactId: memberId, ...(email ? { email } : {}) },
      },
    },
  };
}

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

test.describe('API — Auto-renew cancel keeps access (Phase 1 hotfix)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  async function activeSourceCount(memberId) {
    const row = await db.queryOne(`
      SELECT COUNT(*)::int AS n FROM member_access_sources mas
      JOIN member_access ma ON mas.access_id = ma.id
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2 AND mas.status = 'active'
    `, [seed.HOG_CLIENT_ID, memberId]);
    return row ? row.n : 0;
  }

  test('orderAutoRenewCanceled → normalizes to plan.autorenew_cancelled in webhook_log', async () => {
    const suffix   = `norm-autorenew-${Date.now()}`;
    const memberId = seed.makeWixMemberId(suffix);
    const eventId  = `e2e-ev-${suffix}`;

    await postWebhook(buildAutoRenewCanceledPayload({
      orderId: `e2e-order-${suffix}`, memberId, eventId,
    }));

    const row = await waitFor(() => db.queryOne(`SELECT event_type FROM webhook_log WHERE event_id = $1`, [eventId]));
    expect(row, 'webhook_log row not created for orderAutoRenewCanceled').not.toBeNull();
    expect(row.event_type).toBe('plan.autorenew_cancelled');
    expect(row.event_type).not.toBe('plan.cancelled');
  });

  test('orderAutoRenewCanceled → no revoke job, member stays active', async () => {
    test.setTimeout(90_000);
    const suffix  = `autorenew-keep-${Date.now()}`;
    const eventId = `e2e-ev-${suffix}`;
    const { email, memberId, orderId } = await grantAndActivate(suffix);
    expect(await activeSourceCount(memberId), 'grant never wrote an active source row').toBeGreaterThan(0);

    const res = await postWebhook(buildAutoRenewCanceledPayload({ orderId, memberId, email, eventId }));
    expect(res.status).toBe(200);

    const wl = await waitFor(() => db.queryOne(
      `SELECT event_type, trace_id FROM webhook_log WHERE event_id = $1`, [eventId]
    ));
    expect(wl, 'webhook_log row not created for orderAutoRenewCanceled').not.toBeNull();
    expect(wl.event_type).toBe('plan.autorenew_cancelled');

    // Give a (wrongly) queued revoke every chance to run before judging.
    await new Promise(r => setTimeout(r, NO_REVOKE_SETTLE_MS));

    // No revoke job: nothing revoke-shaped anywhere in this webhook's trace —
    // no revoked member_access_log row, no revoke.* diagnostic, no failed revoke job.
    if (wl.trace_id) {
      const revokeRow = await db.queryOne(`
        SELECT event, source FROM v_trace_timeline
        WHERE trace_id = $1 AND event ILIKE '%revoke%'
        LIMIT 1
      `, [wl.trace_id]);
      expect(revokeRow, `revoke activity found in trace: ${revokeRow && revokeRow.event}`).toBeNull();
    }

    // Member still active, and the plan's source row was not revoked/deleted.
    const status = await db.queryOne(`
      SELECT ma.status FROM member_access ma
      JOIN member_master mm ON ma.member_master_id = mm.id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, memberId]);
    expect(status?.status, 'orderAutoRenewCanceled removed a paid member\'s access').toBe('active');
    expect(await activeSourceCount(memberId), 'active source row gone after orderAutoRenewCanceled').toBeGreaterThan(0);
  });

  test('orderAutoRenewCanceled then orderEnded → access ends only at orderEnded', async () => {
    test.setTimeout(90_000);
    const suffix = `autorenew-then-end-${Date.now()}`;
    const { email, memberId, orderId } = await grantAndActivate(suffix);

    await postWebhook(buildAutoRenewCanceledPayload({ orderId, memberId, email }));
    await new Promise(r => setTimeout(r, NO_REVOKE_SETTLE_MS));
    const stillActive = await waitForStatus(memberId, 'active', 2_000);
    expect(stillActive, 'member lost access at auto-renew cancel').not.toBeNull();

    await postWebhook({
      eventType: 'wixPricingPlans.orderEnded',
      data: {
        entity: {
          _id: orderId, planId: seed.HOG_SOURCE_PLAN_IDS.individual,
          status: 'ENDED', buyer: { memberId, contactId: memberId, email },
        },
      },
    });
    const ended = await waitForStatus(memberId, 'inactive');
    expect(ended, 'orderEnded did not set status=inactive').not.toBeNull();
  });
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
