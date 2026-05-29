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

  test('returns no_telemetry when state row absent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('no_telemetry');
  });

  test('returns version_mismatch when installed != current', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{
        last_telemetry_at: new Date().toISOString(),
        last_telemetry_version: 'v1.0.0',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('version_mismatch');
  });

  test('returns ok when version matches and telemetry is fresh', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{
        last_telemetry_at: new Date().toISOString(),
        last_telemetry_version: 'v2.1.0',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBe('ok');
  });

  test('returns stale_telemetry when telemetry older than registry stale_after_days', async () => {
    const veryOld = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(); // 30 days ago
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [{
        last_telemetry_at: veryOld,
        last_telemetry_version: 'v2.1.0',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/test');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('stale_telemetry');
  });

  test('returns ok for thank_you_redirect (verify_via=none)', async () => {
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
    expect(res.body.result).toBe('ok');
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
