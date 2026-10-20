/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a Wix purchase arrives while the DB or Redis is failing      │
 * │  (BOT review 2026-10-19)                                                │
 * │                                                                         │
 * │  wix-connector used to answer 200 BEFORE dedup + enqueue. When either   │
 * │  then failed, Wix had already seen success and never retried: the       │
 * │  purchase was lost. Now the 200 goes out only once the event is stored  │
 * │  and queued; a failure is a 500 and a slow store a 503, so Wix retries. │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const crypto = require('crypto');

jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../core/webhook-processor', () => ({
  processIncoming: jest.fn(),
  logWebhookAttempt: jest.fn().mockResolvedValue(),
}));
jest.mock('../../core/tenant-resolver', () => ({ registerSiteId: jest.fn().mockResolvedValue() }));
jest.mock('../../core/hmac-monitor', () => ({ recordFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/setup-telemetry', () => ({ recordSnippetTelemetry: jest.fn().mockResolvedValue() }));

const SECRET = 'test-wix-webhook-secret';
process.env.WIX_WEBHOOK_SECRET = SECRET;

const webhookProcessor = require('../../core/webhook-processor');
const { log } = require('../../core/logger');
const wixConnector = require('../../adapters/wix/wix-connector');

function signedRequest() {
  const body = { data: { metadata: { id: 'evt-ack-1' } }, eventType: 'plan.purchased' };
  const rawBody = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('base64');
  return {
    body, rawBody,
    headers: { 'x-wix-signature': signature, 'x-wix-event-type': 'plan.purchased', 'x-wix-site-id': 'site-1' },
  };
}

function fakeRes() {
  const res = { headersSent: false, statusCode: null, sent: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.send = jest.fn((b) => { res.sent = b; res.headersSent = true; return res; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('[P1] a Wix webhook is acknowledged only after it is safely queued', () => {
  test('no 200 goes out while dedup + enqueue are still running; 200 once they finish', async () => {
    let finish;
    webhookProcessor.processIncoming.mockReturnValue(new Promise((r) => { finish = r; }));
    const res = fakeRes();
    const handled = wixConnector.handleWebhook(signedRequest(), res);

    await new Promise((r) => setImmediate(r));
    expect(webhookProcessor.processIncoming).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();          // the old code had already sent 200 here

    finish();
    await handled;
    expect(res.statusCode).toBe(200);
  });

  test('enqueue fails (Redis down) → 500, never 200, so Wix retries the delivery', async () => {
    webhookProcessor.processIncoming.mockRejectedValue(new Error('ECONNREFUSED redis'));
    const res = fakeRes();
    await wixConnector.handleWebhook(signedRequest(), res);
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  test('dedup query fails (DB down) → 500', async () => {
    webhookProcessor.processIncoming.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    const res = fakeRes();
    await wixConnector.handleWebhook(signedRequest(), res);
    expect(res.statusCode).toBe(500);
  });

  test('a handled-but-not-queued event (duplicate, unknown tenant) still gets 200: a retry would not help', async () => {
    webhookProcessor.processIncoming.mockResolvedValue(undefined);   // processIncoming returns early on these
    const res = fakeRes();
    await wixConnector.handleWebhook(signedRequest(), res);
    expect(res.statusCode).toBe(200);
  });

  test('store + queue slower than the 1s budget → 503 before Wix\'s 1.25s timeout; a late failure is still logged', async () => {
    jest.useFakeTimers();
    let fail;
    webhookProcessor.processIncoming.mockReturnValue(new Promise((_, rej) => { fail = rej; }));
    const res = fakeRes();
    const handled = wixConnector.handleWebhook(signedRequest(), res);

    await jest.advanceTimersByTimeAsync(999);
    expect(res.status).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await handled;
    expect(res.statusCode).toBe(503);
    expect(log.warn).toHaveBeenCalledWith('wix.webhook.ack_budget_exceeded', expect.objectContaining({ budgetMs: 1000 }));

    fail(new Error('late redis failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith('wix.webhook.processing_error', expect.objectContaining({ afterAck: true }), expect.any(Error));
    expect(res.status).toHaveBeenCalledTimes(1);   // nothing is sent twice
  });

  test('a bad signature is still a 401 and never reaches the processor', async () => {
    const req = signedRequest();
    req.headers['x-wix-signature'] = 'forged';
    const res = fakeRes();
    await wixConnector.handleWebhook(req, res);
    expect(res.statusCode).toBe(401);
    expect(webhookProcessor.processIncoming).not.toHaveBeenCalled();
  });
});
