/**
 * P2 -- ONBOARDING
 *
 * Wix App Market stub endpoint (OB-66 / F-17 placeholder).
 *
 * Confirms the handler:
 *   1. Always returns 503 with { error: 'wix_app_market_handler_not_implemented', message: <stub> }
 *   2. Writes a webhook_log row with event_type='wix-app-market-stub'
 *   3. Never throws -- even when the DB INSERT fails
 *   4. Tolerates Buffer body (express.raw), string body, and JSON-parsed body
 *
 * This is a stub test by design. When OB-66 ships the real handler, this test
 * should be REPLACED (not extended) with the full JWT-verification + event-
 * branching test suite. Until then, this guards the contract that lets the
 * stub be deployed safely.
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: {
    info:     jest.fn(),
    warn:     jest.fn(),
    error:    jest.fn(),
    critical: jest.fn(),
  },
}));

const db = require('../../db');
const { log } = require('../../core/logger');
const { handleAppMarketWebhook } = require('../../core/wix-app-market');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('POST /webhooks/wix-app-market (stub)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rowCount: 1 });
  });

  test('returns 503 with the canonical not-implemented error code', async () => {
    const req = {
      headers: { 'content-type': 'application/jwt' },
      body: Buffer.from('eyJhbGciOiJSUzI1NiJ9.fake.jwt', 'utf8'),
    };
    const res = mockRes();

    await handleAppMarketWebhook(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error:   'wix_app_market_handler_not_implemented',
      message: expect.stringContaining('OB-66'),
    });
  });

  test('writes a webhook_log row with event_type wix-app-market-stub', async () => {
    const req = {
      headers: { 'content-type': 'application/jwt' },
      body: Buffer.from('payload-bytes', 'utf8'),
    };
    const res = mockRes();

    await handleAppMarketWebhook(req, res);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT\s+INTO\s+webhook_log/i);
    // params: [event_id, client_id, hmac_status, dedup_status, event_type, raw_payload, normalized_payload, error_detail, trace_id]
    expect(params[4]).toBe('wix-app-market-stub');
    // raw_payload is JSON-stringified envelope; confirm it captured the raw body
    const envelope = JSON.parse(params[5]);
    expect(envelope.body_raw).toBe('payload-bytes');
    expect(envelope.content_type).toBe('application/jwt');
    expect(envelope.body_length).toBe('payload-bytes'.length);
  });

  test('still returns 503 when the webhook_log INSERT rejects (never throws)', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));

    const req = {
      headers: { 'content-type': 'application/jwt' },
      body: Buffer.from('whatever', 'utf8'),
    };
    const res = mockRes();

    await expect(handleAppMarketWebhook(req, res)).resolves.toBeDefined();
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('wix_app_market_handler_not_implemented');
  });

  test('handles a string body (not Buffer) without throwing', async () => {
    const req = {
      headers: { 'content-type': 'application/jwt' },
      body: 'raw.jwt.string',
    };
    const res = mockRes();

    await handleAppMarketWebhook(req, res);

    expect(res.statusCode).toBe(503);
    const envelope = JSON.parse(db.query.mock.calls[0][1][5]);
    expect(envelope.body_raw).toBe('raw.jwt.string');
  });

  test('handles a missing body gracefully', async () => {
    const req = { headers: {}, body: undefined };
    const res = mockRes();

    await handleAppMarketWebhook(req, res);

    expect(res.statusCode).toBe(503);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
