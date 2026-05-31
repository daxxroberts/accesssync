/**
 * P2 — Setup Hub route shape (post-2026-05-30 strip-down).
 * Status indicators (install_state, aggregate, envIssues) removed.
 * Only validates the stripped response shape: client + webhook + snippets.
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
jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: (plaintext) => 'ENC[' + plaintext + ']',
  decryptApiKey: (stored)    => stored.replace(/^ENC\[(.+)\]$/, '$1'),
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
    db.query.mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: 'ENC[mock-existing]' }] });

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

  test('response shape contains only the kept fields (no aggregate, envIssues, install_state)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: 'ENC[mock-existing]' }] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    // Kept
    expect(res.body.clientId).toBeDefined();
    expect(res.body.webhookUrl).toBeDefined();
    expect(res.body.hmacSecret).toBeDefined();
    expect(res.body.hmacSource).toBeDefined();
    expect(Array.isArray(res.body.snippets)).toBe(true);

    // Removed 2026-05-30 — no synthetic status
    expect(res.body.aggregate).toBeUndefined();
    expect(res.body.envIssues).toBeUndefined();
    res.body.snippets.forEach(s => {
      expect(s.install_state).toBeUndefined();
      expect(s.last_telemetry_at).toBeUndefined();
      expect(s.version_installed).toBeUndefined();
    });
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
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: 'ENC[mock-existing]' }] })
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
