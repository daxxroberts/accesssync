/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ADMIN CLIENTS PANEL                              │
 * │  Scenario: admin/routes/clients.js list + archive + restore + delete    │
 * │                                                                         │
 * │  These are route-level unit tests: all DB calls are mocked, Express is  │
 * │  not started. We verify the contract the admin-panel.ejs UI depends on: │
 * │    - GET /admin/clients returns { data: [...] } with the expected shape │
 * │    - POST /:id/archive flips status='archived' + sets archived_at       │
 * │    - POST /:id/restore  flips status='active'   + clears archived_at    │
 * │    - DELETE /:id without confirm → 400 with confirmation_required hint  │
 * │    - DELETE /:id with wrong confirm → 400                               │
 * │    - DELETE /:id with correct confirm → 200 ok                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((v) => `dec-${v}`),
  encryptApiKey: jest.fn((v) => `enc-${v}`),
}));

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole: jest.fn(),
}));

jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../admin/middleware/audit', () => ({
  logAdminAction: jest.fn(),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-admin-panel-test'),
  getActor:   jest.fn(() => ({ type: 'admin', id: 'owner' })),
  setTraceContext: jest.fn(),
}));

const db = require('../../db');

// ── Helpers ────────────────────────────────────────────────────────────────

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

function makePgClient() {
  return {
    query:    jest.fn().mockResolvedValue({ rows: [] }),
    release:  jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── GET /admin/clients ─────────────────────────────────────────────────────

describe('[P2] GET /admin/clients — list shape for admin-panel.ejs', () => {
  test('returns { data: [...] } with id, name, status, member_count, active_count', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'client-1',
        name: 'House of Gains',
        platform: 'wix',
        source_site_id: 'site-1',
        source_site_name: 'HOG',
        status: 'active',
        notification_email: 'chad@hog.com',
        last_sync_at: '2026-05-27T10:00:00Z',
        archived_at: null,
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-05-27T10:00:00Z',
        connector_platform: 'kisi',
        billing_tier: 'Pro',
        member_count: 42,
        active_count: 38,
      }],
    });

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'get', '/');
    const req = { query: { status: 'active' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row.id).toBe('client-1');
    expect(row.name).toBe('House of Gains');
    expect(row.status).toBe('active');
    expect(row.member_count).toBe(42);
    expect(row.active_count).toBe(38);
    expect(row.last_sync_at).toBe('2026-05-27T10:00:00Z');
    expect(row.archived_at).toBeNull();
  });

  test('?status=archived filters to archived clients via WHERE c.status = $1', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'get', '/');
    await handler({ query: { status: 'archived' } }, mockRes());
    const call = db.query.mock.calls[0];
    expect(call[0]).toMatch(/c\.status = \$1/);
    expect(call[1]).toEqual(['archived']);
  });

  test("default (no status) excludes archived rows", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'get', '/');
    await handler({ query: {} }, mockRes());
    const call = db.query.mock.calls[0];
    expect(call[0]).toMatch(/c\.status\s*!=\s*'archived'/);
  });
});

// ── POST /admin/clients/:id/archive ────────────────────────────────────────

describe('[P2] POST /admin/clients/:id/archive', () => {
  test('sets status=archived + archived_at=NOW() and returns the updated row', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'client-1', name: 'HOG', status: 'archived', archived_at: '2026-05-27T11:00:00Z' }],
    });

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'post', '/:id/archive');
    const req = { params: { id: 'client-1' }, body: {} };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.client.status).toBe('archived');

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE clients/);
    expect(sql).toMatch(/status\s*=\s*'archived'/);
    expect(sql).toMatch(/archived_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/status\s*!=\s*'archived'/);
  });

  test('returns 404 when client not found or already archived', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'post', '/:id/archive');
    const res = mockRes();
    await handler({ params: { id: 'missing' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /admin/clients/:id/restore ────────────────────────────────────────

describe('[P2] POST /admin/clients/:id/restore', () => {
  test('flips status back to active and clears archived_at', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'client-1', name: 'HOG', status: 'active' }],
    });

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'post', '/:id/restore');
    const res = mockRes();
    await handler({ params: { id: 'client-1' }, body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.client.status).toBe('active');

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE clients/);
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/archived_at\s*=\s*NULL/);
    expect(sql).toMatch(/status\s*=\s*'archived'/);
  });

  test('returns 404 when client not archived', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'post', '/:id/restore');
    const res = mockRes();
    await handler({ params: { id: 'not-archived' }, body: {} }, res);
    expect(res.statusCode).toBe(404);
  });
});

// ── DELETE /admin/clients/:id ──────────────────────────────────────────────

describe('[P2] DELETE /admin/clients/:id — confirmation gate', () => {
  test('without confirm body returns 400 with expected confirmation string', async () => {
    const pg = makePgClient();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'client-1', name: 'House of Gains' }] });
    db.getClient.mockResolvedValueOnce(pg);

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'delete', '/:id');
    const res = mockRes();
    await handler({ params: { id: 'client-1' }, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Confirmation required');
    expect(res.body.expected).toBe('DELETE House of Gains');
    expect(res.body.message).toContain('DELETE House of Gains');
    expect(pg.release).toHaveBeenCalled();
  });

  test('with wrong confirm string returns 400', async () => {
    const pg = makePgClient();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'client-1', name: 'House of Gains' }] });
    db.getClient.mockResolvedValueOnce(pg);

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'delete', '/:id');
    const res = mockRes();
    await handler(
      { params: { id: 'client-1' }, body: { confirm: 'DELETE wrong-name' } },
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Confirmation required');
    expect(pg.release).toHaveBeenCalled();
  });

  test('with correct confirm string runs BEGIN/COMMIT cascade and returns ok', async () => {
    const pg = makePgClient();
    // 1. SELECT client name
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'client-1', name: 'House of Gains' }] });
    // 2..N: BEGIN, audit insert, cleanup deletes, cascade delete, COMMIT — generic { rows: [] }
    pg.query.mockResolvedValue({ rows: [] });
    db.getClient.mockResolvedValueOnce(pg);

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'delete', '/:id');
    const res = mockRes();
    await handler(
      { params: { id: 'client-1' }, body: { confirm: 'DELETE House of Gains' } },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('House of Gains');

    const sqls = pg.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /BEGIN/.test(s))).toBe(true);
    expect(sqls.some(s => /COMMIT/.test(s))).toBe(true);
    expect(sqls.some(s => /DELETE FROM clients WHERE id = \$1/.test(s))).toBe(true);
    expect(pg.release).toHaveBeenCalled();
  });

  test('returns 404 when client not found', async () => {
    const pg = makePgClient();
    pg.query.mockResolvedValueOnce({ rows: [] });
    db.getClient.mockResolvedValueOnce(pg);

    const router = require('../../admin/routes/clients');
    const handler = findRouteHandler(router, 'delete', '/:id');
    const res = mockRes();
    await handler(
      { params: { id: 'missing' }, body: { confirm: 'DELETE whatever' } },
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Client not found');
    expect(pg.release).toHaveBeenCalled();
  });
});
