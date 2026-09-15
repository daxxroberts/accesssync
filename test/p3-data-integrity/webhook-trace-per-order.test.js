/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: one Wix purchase → ONE trace in the Logs view                │
 * │                                                                         │
 * │  Wix fires several webhooks for a single purchase inside the same       │
 * │  second (orderUpdated DRAFT/UNPAID ×2, orderUpdated ACTIVE/PAID,        │
 * │  orderPurchased, orderStarted — production webhook_log 2026-09-14),     │
 * │  each with its own event id. Minting a random trace id per request     │
 * │  showed operators five traces per purchase. The ingress now derives     │
 * │  the trace id from the Wix ORDER id, so every webhook — and later       │
 * │  renewals / cancellation on that order — lands in one timeline.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/webhook-processor', () => ({
  eventQueue: {},
  processIncoming: jest.fn().mockResolvedValue(),
  logWebhookAttempt: jest.fn().mockResolvedValue(),
}));
jest.mock('../../core/hmac-monitor', () => ({ recordFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/tenant-resolver', () => ({ registerSiteId: jest.fn().mockResolvedValue() }));
jest.mock('../../core/setup-telemetry', () => ({ recordSnippetTelemetry: jest.fn().mockResolvedValue() }));
jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: (p) => p, decryptApiKey: (s) => s,
}));

const { deriveTraceId, mintTraceId } = require('../../core/trace-context');
const webhookProcessor = require('../../core/webhook-processor');

// Same shape the admin log routes and middleware enforce (version nibble 1-5).
const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ORDER_ID  = 'df8d1946-a77a-3707-b2e1-e637c65cd8dc';
const MEMBER_ID = '2a6e78ae-c687-4001-b241-513a39ef8964';
const PLAN_ID   = '27704aeb-a669-4239-907f-ce831adcad80';

function paidOrder(extra = {}) {
  return {
    _id: ORDER_ID, planId: PLAN_ID, status: 'ACTIVE', lastPaymentStatus: 'PAID',
    buyer: { memberId: MEMBER_ID }, currentCycle: { index: 1 }, ...extra,
  };
}

// The three production payload shapes for one purchase, plus the two
// DRAFT/UNPAID orderUpdated echoes that precede them.
function purchaseWebhooks() {
  const draft = paidOrder({ status: 'DRAFT', lastPaymentStatus: 'UNPAID', currentCycle: { index: 0 } });
  return [
    { eventType: 'wixPricingPlans.orderUpdated',   body: { data: { metadata: { id: 'evt-1' }, entity: draft } } },
    { eventType: 'wixPricingPlans.orderUpdated',   body: { data: { metadata: { id: 'evt-2' }, entity: draft } } },
    { eventType: 'wixPricingPlans.orderUpdated',   body: { data: { metadata: { id: 'evt-3' }, entity: paidOrder() } } },
    { eventType: 'wixPricingPlans.orderPurchased', body: { data: { metadata: { id: 'evt-4' }, data: { order: paidOrder() } } } },
    { eventType: 'wixPricingPlans.orderStarted',   body: { data: { metadata: { id: 'evt-5' }, data: { order: paidOrder() } } } },
  ];
}

function mockReqRes({ eventType, body }) {
  const req = {
    rawBody: JSON.stringify(body),
    body,
    headers: {
      'x-wix-signature':  'sig',
      'x-wix-event-type': eventType,
      'x-wix-site-id':    'site-hog',
    },
  };
  const res = { headersSent: false, status: jest.fn().mockReturnThis(), send: jest.fn() };
  return { req, res };
}

function loadConnector() {
  delete require.cache[require.resolve('../../adapters/wix/wix-connector')];
  const connector = require('../../adapters/wix/wix-connector');
  connector._verifySignature = jest.fn().mockResolvedValue(true);
  return connector;
}

beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════════════════════
describe('[P3] deriveTraceId — deterministic, well-formed, collision-free', () => {
  test('same key → same id; different key → different id', () => {
    expect(deriveTraceId('wix-order:' + ORDER_ID)).toBe(deriveTraceId('wix-order:' + ORDER_ID));
    expect(deriveTraceId('wix-order:' + ORDER_ID)).not.toBe(deriveTraceId('wix-order:other'));
  });

  test('passes the trace-id validators used by the Logs routes and middleware', () => {
    expect(deriveTraceId('wix-order:' + ORDER_ID)).toMatch(TRACE_RE);
    expect(deriveTraceId('anything')).toMatch(TRACE_RE);
  });

  test('never collides with a freshly minted v4 id (different version nibble)', () => {
    expect(deriveTraceId('x')).not.toMatch(UUID_V4);
    expect(mintTraceId()).toMatch(UUID_V4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P3] wix-connector — every webhook for one order shares one trace', () => {
  test('5 webhooks / 5 event ids for one purchase → 1 trace id, derived from the order id', async () => {
    const connector = loadConnector();
    for (const w of purchaseWebhooks()) {
      const { req, res } = mockReqRes(w);
      await connector.handleWebhook(req, res);
    }
    const calls = webhookProcessor.processIncoming.mock.calls;
    expect(calls).toHaveLength(5);

    const eventIds = calls.map(c => c[0]);
    const traceIds = calls.map(c => c[1].traceId);
    expect(new Set(eventIds).size).toBe(5);                 // still five distinct events (dedup untouched)
    expect(new Set(traceIds).size).toBe(1);                 // …but one trace
    expect(traceIds[0]).toBe(deriveTraceId('wix-order:' + ORDER_ID));
    expect(traceIds[0]).toMatch(TRACE_RE);
  });

  test('a later event on the same order (cancellation) joins the same trace', async () => {
    const connector = loadConnector();
    const cancel = {
      eventType: 'wixPricingPlans.orderCanceled',
      body: { data: { metadata: { id: 'evt-cancel' }, entity: paidOrder({ status: 'CANCELED' }) } },
    };
    const { req, res } = mockReqRes(cancel);
    await connector.handleWebhook(req, res);
    const ev = webhookProcessor.processIncoming.mock.calls[0][1];
    expect(ev.eventType).toBe('plan.cancelled');
    expect(ev.traceId).toBe(deriveTraceId('wix-order:' + ORDER_ID));
  });

  test('two different orders → two different traces', async () => {
    const connector = loadConnector();
    const a = { eventType: 'wixPricingPlans.orderPurchased', body: { data: { data: { order: paidOrder({ _id: 'order-A' }) } } } };
    const b = { eventType: 'wixPricingPlans.orderPurchased', body: { data: { data: { order: paidOrder({ _id: 'order-B' }) } } } };
    for (const w of [a, b]) { const { req, res } = mockReqRes(w); await connector.handleWebhook(req, res); }
    const [ta, tb] = webhookProcessor.processIncoming.mock.calls.map(c => c[1].traceId);
    expect(ta).not.toBe(tb);
  });

  test('webhook with no order id (member.deleted) keeps a random per-request v4 trace', async () => {
    const connector = loadConnector();
    const w = {
      eventType: 'wixMembers.memberDeleted',
      body: { data: { metadata: { id: 'evt-del' }, entity: { member: { _id: MEMBER_ID } } } },
    };
    const { req, res } = mockReqRes(w);
    await connector.handleWebhook(req, res);
    const ev = webhookProcessor.processIncoming.mock.calls[0][1];
    expect(ev.wixOrderId).toBeNull();
    expect(ev.traceId).toMatch(UUID_V4);
  });

  test('HMAC-rejected request never reaches the processor and logs with a v4 trace', async () => {
    const connector = loadConnector();
    connector._verifySignature = jest.fn().mockResolvedValue(false);
    const { req, res } = mockReqRes(purchaseWebhooks()[3]);
    await connector.handleWebhook(req, res);
    expect(webhookProcessor.processIncoming).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    const attempt = webhookProcessor.logWebhookAttempt.mock.calls[0][0];
    expect(attempt.traceId).toMatch(UUID_V4);
  });
});
