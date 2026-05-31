/**
 * P2 — Setup telemetry.
 * OB-237 Phase C. Validates that the webhook version header writes
 * correctly to operator_setup_state via recordSnippetTelemetry.
 * (Test Connection route tests removed 2026-05-30 with the endpoint.)
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

// Test Connection endpoint removed 2026-05-30. Previous describe block
// for POST /:clientId/setup-state/test deleted in this same commit.

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
