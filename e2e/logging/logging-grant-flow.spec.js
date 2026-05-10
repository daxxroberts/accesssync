/**
 * e2e/logging/logging-grant-flow.spec.js
 * Verifies that a full grant flow (webhook → queue-worker → grant-revoke → Kisi)
 * produces the expected rows in v_trace_timeline.
 *
 * Uses the HOG client with real Kisi calls. Test members are cleaned up after.
 * ~45 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Helper: wait for a v_trace_timeline row to appear (queue processing is async).
// Filter is matched against source OR event (case-insensitive substring) — sources are
// 'webhook', 'member_access', 'diagnostic'; events are domain names like 'plan.purchased',
// 'provisioned', 'KISI_RESPONSE_ERROR'.
async function waitForTraceRow(traceId, filter, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.queryRows(`
      SELECT * FROM v_trace_timeline
      WHERE trace_id = $1 AND (source ILIKE $2 OR event ILIKE $2)
      ORDER BY ts DESC LIMIT 1
    `, [traceId, `%${filter}%`]);
    if (rows.length > 0) return rows[0];
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Helper: extract trace_id from webhook_log after posting
async function getTraceIdFromWebhookLog(eventId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = await db.queryOne(`
      SELECT trace_id FROM webhook_log WHERE event_id = $1
    `, [eventId]);
    if (row?.trace_id) return row.trace_id;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

test.describe.configure({ mode: 'serial' });

test.describe('Logging — Grant Flow (HOG real Kisi)', () => {
  let email, wixMemberId, orderId, eventId;

  test.beforeEach(async () => {
    const suffix    = `grant-${Date.now()}`;
    email           = seed.makeE2eEmail(suffix);
    wixMemberId     = seed.makeWixMemberId(suffix);
    orderId         = `e2e-order-${suffix}`;
    eventId         = `e2e-event-${suffix}`;
  });

  test.afterEach(async () => {
    await seed.teardownHogTestMembers();
  });

  test('webhook POST returns 200', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId,
      memberId:  wixMemberId,
      planId:    seed.HOG_SOURCE_PLAN_IDS.individual,
      email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    const res = await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });
    expect(res.status).toBe(200);
  });

  test('webhook_log row created with hmac_status=accepted', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const deadline = Date.now() + 8_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`SELECT * FROM webhook_log WHERE event_id = $1`, [eventId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 300));
    }
    expect(row, 'webhook_log row not created').not.toBeNull();
    expect(row.hmac_status).toBe('accepted');
    expect(row.event_type).toBe('plan.purchased');
  });

  test('trace_id is assigned and visible in webhook_log', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const traceId = await getTraceIdFromWebhookLog(eventId);
    expect(traceId, 'No trace_id on webhook_log row').toBeTruthy();
  });

  test('member_master row created after grant', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const deadline = Date.now() + 15_000;
    let row = null;
    while (Date.now() < deadline) {
      row = await db.queryOne(`
        SELECT * FROM member_master
        WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      if (row) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(row, 'member_master not created').not.toBeNull();
    expect(row.email).toBe(email);
  });

  test('member_access row created with status=active after grant', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const deadline = Date.now() + 15_000;
    let row = null;
    while (Date.now() < deadline) {
      const master = await db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      if (master) {
        row = await db.queryOne(`
          SELECT * FROM member_access WHERE member_master_id = $1
        `, [master.id]);
      }
      if (row?.status === 'active') break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(row, 'member_access not created').not.toBeNull();
    expect(row.status).toBe('active');
  });

  test('member_billing row created with wix_order_id set', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const deadline = Date.now() + 15_000;
    let billingRow = null;
    while (Date.now() < deadline) {
      billingRow = await db.queryOne(`
        SELECT mb.* FROM member_billing mb
        JOIN member_master mm ON mb.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      if (billingRow) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(billingRow, 'member_billing not created').not.toBeNull();
    expect(billingRow.wix_order_id).toBe(orderId);
    expect(billingRow.cycle_index).toBe(1);
  });

  test('v_trace_timeline has ingress row for the grant', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const traceId = await getTraceIdFromWebhookLog(eventId);
    expect(traceId).toBeTruthy();

    const row = await waitForTraceRow(traceId, 'ingress');
    expect(row, 'No ingress row in v_trace_timeline').not.toBeNull();
  });

  test('v_trace_timeline has grant row after processing', async () => {
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const traceId = await getTraceIdFromWebhookLog(eventId);
    expect(traceId).toBeTruthy();

    const row = await waitForTraceRow(traceId, 'grant', 20_000);
    expect(row, 'No grant row in v_trace_timeline — check queue-worker and Kisi').not.toBeNull();
    expect(row.result).toBe('success');
  });

  test('member_access_sources row has effective_start set after grant', async () => {
    const startDate = new Date('2026-05-01T00:00:00Z').toISOString();
    const payload = seed.buildOrderPurchasedPayload({
      orderId, memberId: wixMemberId,
      planId: seed.HOG_SOURCE_PLAN_IDS.individual, email,
      startDate,
    });
    const body = JSON.stringify({ ...payload, eventId });
    const headers = auth.buildWebhookHeaders(body, { siteId: seed.HOG_WIX_SITE_ID });
    await fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body });

    const deadline = Date.now() + 20_000;
    let sourcesRow = null;
    while (Date.now() < deadline) {
      sourcesRow = await db.queryOne(`
        SELECT mas.* FROM member_access_sources mas
        JOIN member_access ma ON mas.access_id = ma.id
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
        LIMIT 1
      `, [seed.HOG_CLIENT_ID, wixMemberId]);
      if (sourcesRow?.effective_start) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(sourcesRow, 'member_access_sources row not created').not.toBeNull();
    expect(sourcesRow.effective_start).not.toBeNull();
  });
});

test.describe('Logging — Grant Flow counts in v_trace_timeline', () => {
  test('all sources in v_trace_timeline are well-formed (have ts, event, source)', async () => {
    const rows = await db.queryRows(`
      SELECT ts, event, source, trace_id FROM v_trace_timeline
      WHERE ts > NOW() - INTERVAL '1 hour'
      LIMIT 50
    `, []);
    for (const row of rows) {
      expect(row.ts, 'v_trace_timeline row missing ts').toBeTruthy();
      expect(row.event, 'v_trace_timeline row missing event').toBeTruthy();
      expect(row.source, 'v_trace_timeline row missing source').toBeTruthy();
    }
  });

  test('v_trace_timeline only shows rows where trace_id IS NOT NULL', async () => {
    const nullTraceRows = await db.queryOne(`
      SELECT COUNT(*)::int as cnt FROM v_trace_timeline WHERE trace_id IS NULL
    `, []);
    expect(nullTraceRows.cnt).toBe(0);
  });
});
