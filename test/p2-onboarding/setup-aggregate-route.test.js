/**
 * P2 — Setup aggregate route (Dashboard pill).
 * OB-237 Phase D. Lightweight aggregate-only endpoint used by Dashboard pill.
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

describe('GET /operator/:clientId/setup-aggregate', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
    process.env.WIX_WEBHOOK_SECRET = 'shhh';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('red when env vars missing (CORE_ENGINE_URL)', async () => {
    delete process.env.CORE_ENGINE_URL;
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('red');
    expect(res.body.message).toContain('CORE_ENGINE_URL');
  });

  test('red when a required snippet has no install row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('red');
    expect(res.body.attentionCount).toBeGreaterThan(0);
  });

  test('amber when all required installed but a version is stale', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [
        { snippet_id: 'velo_events_backend', install_state: 'verified', version_installed: 'v1.0.0' },
        { snippet_id: 'sync_status_page',    install_state: 'verified', version_installed: 'v2.1.0' },
        { snippet_id: 'my_access_page',      install_state: 'verified', version_installed: 'v2.1.0' },
      ] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('amber');
  });

  test('green when all required snippets installed at current version', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [
        { snippet_id: 'velo_events_backend', install_state: 'verified', version_installed: 'v2.1.0' },
        { snippet_id: 'sync_status_page',    install_state: 'verified', version_installed: 'v2.1.0' },
        { snippet_id: 'my_access_page',      install_state: 'verified', version_installed: 'v2.1.0' },
      ] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('green');
    expect(res.body.attentionCount).toBe(0);
  });

  test('returns 404 for unknown client', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'unknown' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });

  test('response does not leak full snippet bodies (lightweight by design)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-aggregate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.snippets).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('CLIENT_ID');
    expect(JSON.stringify(res.body)).not.toContain('createHmac');
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
