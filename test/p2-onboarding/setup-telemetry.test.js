/**
 * P2 — Setup telemetry + Test Connection route.
 * OB-237 Phase C. Validates that webhook version header writes to
 * operator_setup_state and that the Test Connection round-trip returns
 * sensible diagnoses (no_telemetry / stale / version_mismatch / ok).
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/webhook-processor', () => ({ eventQueue: {} }));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAuthOrOperator: (req, res, next) => next(),
  signOperatorToken: jest.fn(),
}));
jest.mock('../../admin/middleware/activity', () => ({
  recordActivity: jest.fn(),
}));

const db = require('../../db');

describe('core/setup-telemetry.recordSnippetTelemetry()', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('no-op when clientId is missing', async () => {
    const telemetry = require('../../core/setup-telemetry');
    await telemetry.recordSnippetTelemetry(null, 'velo_events_backend', 'v2.1.0');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('no-op when snippetId is unknown to registry', async () => {
    const telemetry = require('../../core/setup-telemetry');
    await telemetry.recordSnippetTelemetry('client-1', 'totally_unknown_snippet', 'v1');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('writes verified when version matches registry current_version', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const telemetry = require('../../core/setup-telemetry');
    await telemetry.recordSnippetTelemetry('client-1', 'velo_events_backend', 'v2.1.0');
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('operator_setup_state');
    expect(params[0]).toBe('client-1');
    expect(params[1]).toBe('velo_events_backend');
    expect(params[2]).toBe('verified');
    expect(params[3]).toBe('v2.1.0');
  });

  test('writes stale when version does not match registry current_version', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const telemetry = require('../../core/setup-telemetry');
    await telemetry.recordSnippetTelemetry('client-1', 'velo_events_backend', 'v1.0.0');
    const [, params] = db.query.mock.calls[0];
    expect(params[2]).toBe('stale');
  });

  test('never throws when db.query rejects (observability doctrine DR-037)', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    const telemetry = require('../../core/setup-telemetry');
    await expect(
      telemetry.recordSnippetTelemetry('client-1', 'velo_events_backend', 'v2.1.0')
    ).resolves.toBeUndefined();
  });
});

describe('POST /operator/:clientId/setup-state/test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
  });

  // events.js path: 4 db queries — SELECT client, SELECT state, SELECT latest webhook, SELECT latest accepted webhook

  test('events.js: ok when version telemetry matches current_version', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })  // client
      .mockResolvedValueOnce({ rows: [{                        // state
        last_telemetry_at: new Date().toISOString(),
        last_telemetry_version: 'v2.1.0',
      }] })
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString(), hmac_status: 'accepted' }] }) // latest webhook
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString() }] })                          // latest accepted
      .mockResolvedValueOnce({ rowCount: 1 });                                                                // recordTestResult UPSERT

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBe('ok');
    expect(res.body.message).toContain('Verified');
  });

  test('events.js: version_mismatch when installed != current', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{
        last_telemetry_at: new Date().toISOString(),
        last_telemetry_version: 'v1.0.0',
      }] })
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString(), hmac_status: 'accepted' }] })
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('version_mismatch');
  });

  test('events.js: evidence_without_version when accepted webhooks exist but no telemetry yet (the HOG case)', async () => {
    // This is the exact scenario Builder hit: pasted v2.1, published Wix,
    // no event has fired yet, but historical accepted webhooks exist.
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })  // no telemetry row
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString(), hmac_status: 'accepted' }] })
      .mockResolvedValueOnce({ rows: [{ received_at: new Date(Date.now() - 60_000).toISOString() }] })  // 1 min ago
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);  // soft-positive — evidence shows snippet works
    expect(res.body.result).toBe('evidence_without_version');
    expect(res.body.message).toContain('trigger a plan event in Wix');
  });

  test('events.js: hmac_failed when latest webhook was rejected', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ received_at: new Date().toISOString(), hmac_status: 'rejected' }] })
      .mockResolvedValueOnce({ rows: [] })  // no accepted
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('hmac_failed');
    expect(res.body.message).toMatch(/HMAC|secret/i);
  });

  test('events.js: no_activity when zero webhooks have ever arrived', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })  // no telemetry
      .mockResolvedValueOnce({ rows: [] })  // no webhooks at all
      .mockResolvedValueOnce({ rows: [] })  // no accepted
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('no_activity');
    expect(res.body.message).toMatch(/trigger a test plan event/i);
  });

  // iframe snippets: 3 db queries — SELECT client, SELECT state, then UPSERT

  test('iframe: ok when version heartbeat matches current_version', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{
        last_telemetry_at: new Date().toISOString(),
        last_telemetry_version: 'v2.1.0',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'sync_status_page' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBe('ok');
  });

  test('iframe: no_heartbeat when no telemetry ever received', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })  // no telemetry
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'sync_status_page' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('no_heartbeat');
    expect(res.body.message).toMatch(/logged in as a member/i);
  });

  test('thank_you_redirect: returns no_verification (no telemetry path exists)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'thank_you_redirect' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBe('no_verification');
    expect(res.body.message).toMatch(/no automatic verification/i);
  });

  test('400 when snippet_id missing', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

function findRouteHandler(router, method, pathPattern) {
  const layer = router.stack.find(l => l.route &&
    l.route.path === pathPattern &&
    l.route.methods[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${pathPattern}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
