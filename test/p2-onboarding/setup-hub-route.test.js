/**
 * P2 — Setup Hub route shape.
 * OB-237 Phase B. Validates GET /operator/:clientId/setup-state returns
 * the registry-driven shape with aggregate + per-snippet states.
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

describe('GET /operator/:clientId/setup-state', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL   = 'https://admin.example.com';
    process.env.WIX_WEBHOOK_SECRET = 'shhhh';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('returns aggregate red when CORE_ENGINE_URL is missing', async () => {
    delete process.env.CORE_ENGINE_URL;
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.aggregate).toBe('red');
    expect(res.body.envIssues).toContain('CORE_ENGINE_URL');
  });

  test('returns aggregate red when ADMIN_HUB_URL is missing', async () => {
    delete process.env.ADMIN_HUB_URL;
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('red');
    expect(res.body.envIssues).toContain('ADMIN_HUB_URL');
  });

  test('returns 404 when client not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'unknown' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });

  test('returns snippet body for velo_events_backend with substitutions applied', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    const events = res.body.snippets.find(s => s.id === 'velo_events_backend');
    expect(events).toBeDefined();
    expect(events.body).toContain("CLIENT_ID = 'client-1'");
    expect(events.body).toContain('https://core.example.com/webhooks/wix');
    expect(events.render_error).toBeNull();
  });

  test('snippet install_state defaults to not_installed when no row in operator_setup_state', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    const events = res.body.snippets.find(s => s.id === 'velo_events_backend');
    expect(events.install_state).toBe('not_installed');
  });

  test('aggregate red when a required snippet has no install row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.aggregate).toBe('red');
  });

  test('aggregate amber when required snippet is installed but version is stale', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rows: [
        { snippet_id: 'velo_events_backend', install_state: 'verified', version_installed: 'v1.0.0' },
        { snippet_id: 'sync_status_page',    install_state: 'verified', version_installed: 'v2.1.0' },
        { snippet_id: 'my_access_page',      install_state: 'verified', version_installed: 'v2.1.0' },
      ] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    const events = res.body.snippets.find(s => s.id === 'velo_events_backend');
    expect(events.install_state).toBe('stale');
    expect(res.body.aggregate).toBe('amber');
  });
});

describe('POST /operator/:clientId/setup-state/copied', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
  });

  test('records copy action as installed_unverified', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/copied');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'velo_events_backend' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(2);
    const upsertCall = db.query.mock.calls[1];
    expect(upsertCall[0]).toContain('installed_unverified');
    expect(upsertCall[1]).toEqual(['client-1', 'velo_events_backend', 'v2.1.0']);
  });

  test('400 when snippet_id missing', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/copied');
    const req = { params: { clientId: 'client-1' }, body: {} };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('404 when snippet_id not in registry', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/setup-state/copied');
    const req = { params: { clientId: 'client-1' }, body: { snippet_id: 'unknown_snippet' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('snippet_not_found');
  });
});

// ── Helpers ────────────────────────────────────────────────────────
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
