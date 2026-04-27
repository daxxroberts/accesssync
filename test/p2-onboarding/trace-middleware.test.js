/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING                                               │
 * │  Scenario: trace-context middleware mounts correctly                    │
 * │                                                                         │
 * │  Business consequence: If trace middleware fails to mount or resolves  │
 * │  the wrong actor, every log row for that operator session is missing   │
 * │  trace_id / has wrong actor — Admin Hub timeline queries return noise.  │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express  = require('express');
const { traceContextMiddleware, resolveActor } = require('../../admin/middleware/trace-context');
const { getTraceId, getActor }                 = require('../../core/trace-context');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Minimal Express app for testing ──────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(traceContextMiddleware);

  // Echo trace context for inspection
  app.get('/echo', (req, res) => {
    res.json({
      traceId: getTraceId(),
      actor:   getActor(),
    });
  });

  return app;
}

// Simple supertest-style helper using Node's http module
const http = require('http');

function request(app) {
  return {
    get(path, headers = {}) {
      return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.listen(0, () => {
          const port = server.address().port;
          const options = { hostname: 'localhost', port, path, method: 'GET', headers };
          const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              server.close();
              try {
                resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
              } catch {
                resolve({ status: res.statusCode, headers: res.headers, body });
              }
            });
          });
          req.on('error', err => { server.close(); reject(err); });
          req.end();
        });
      });
    }
  };
}

// ── traceContextMiddleware ─────────────────────────────────────────────────

describe('[P2] trace-context middleware: x-trace-id header behavior', () => {
  const app = makeApp();

  test('mints UUID v4 when no inbound x-trace-id header', async () => {
    const res = await request(app).get('/echo');
    expect(res.headers['x-trace-id']).toMatch(UUID_V4);
  });

  test('honors valid inbound x-trace-id header', async () => {
    const inbound = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const res = await request(app).get('/echo', { 'x-trace-id': inbound });
    expect(res.headers['x-trace-id']).toBe(inbound);
  });

  test('rejects malformed inbound trace ID and mints fresh UUID', async () => {
    const res = await request(app).get('/echo', { 'x-trace-id': 'not-a-uuid' });
    expect(res.headers['x-trace-id']).toMatch(UUID_V4);
    expect(res.headers['x-trace-id']).not.toBe('not-a-uuid');
  });

  test('rejects injection-style string and mints fresh UUID', async () => {
    const res = await request(app).get('/echo', { 'x-trace-id': '<script>alert(1)</script>' });
    expect(res.headers['x-trace-id']).toMatch(UUID_V4);
  });

  test('downstream handler receives trace ID from ALS', async () => {
    const inbound = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const res = await request(app).get('/echo', { 'x-trace-id': inbound });
    expect(res.body.traceId).toBe(inbound);
  });

});

// ── resolveActor unit tests ───────────────────────────────────────────────────

describe('[P2] resolveActor: correct actor type from request context', () => {

  const ADMIN_EMAIL = 'daxxroberts@gmail.com';

  beforeAll(() => {
    process.env.ADMIN_ALLOWED_EMAIL = ADMIN_EMAIL;
  });

  function mockReq(overrides = {}) {
    return { path: '/test', headers: {}, ...overrides };
  }

  test('resolves owner when req.admin.email matches ADMIN_ALLOWED_EMAIL', () => {
    const req = mockReq({ admin: { email: ADMIN_EMAIL } });
    expect(resolveActor(req)).toEqual({ type: 'owner', id: ADMIN_EMAIL });
  });

  test('resolves operator when req.admin.email does not match owner email', () => {
    const req = mockReq({ admin: { email: 'chad@hog.com' } });
    expect(resolveActor(req)).toEqual({ type: 'operator', id: 'chad@hog.com' });
  });

  test('resolves operator with wix: prefix when req.admin.role=operator + clientId', () => {
    const req = mockReq({ admin: { role: 'operator', clientId: 'c-abc-123' } });
    expect(resolveActor(req)).toEqual({ type: 'operator', id: 'wix:c-abc-123' });
  });

  test('resolves operator with wix-uid: prefix from req.wixOperator', () => {
    const req = mockReq({ wixOperator: { uid: 'uid-abc' } });
    expect(resolveActor(req)).toEqual({ type: 'operator', id: 'wix-uid:uid-abc' });
  });

  test('resolves member from req.member.id', () => {
    const req = mockReq({ member: { id: 'member-uuid-123' } });
    expect(resolveActor(req)).toEqual({ type: 'member', id: 'member-uuid-123' });
  });

  test('resolves webhook actor on /webhook path', () => {
    const req = mockReq({ path: '/webhooks/wix' });
    expect(resolveActor(req)).toEqual({ type: 'webhook', id: '/webhooks/wix' });
  });

  test('resolves system:anonymous on public/unauthenticated routes', () => {
    const req = mockReq({ path: '/health' });
    expect(resolveActor(req)).toEqual({ type: 'system', id: 'anonymous' });
  });

  test('resolves system:anonymous on /sync-status (member pre-auth)', () => {
    const req = mockReq({ path: '/sync-status' });
    expect(resolveActor(req)).toEqual({ type: 'system', id: 'anonymous' });
  });

});

// ── Concurrency isolation ─────────────────────────────────────────────────────

describe('[P2] trace-context middleware: concurrent requests do not leak context', () => {

  test('50 parallel requests each see their own distinct trace ID', async () => {
    const app = makeApp();
    const CONCURRENCY = 50;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => request(app).get('/echo'))
    );

    const traceIds = results.map(r => r.headers['x-trace-id']);
    const unique = new Set(traceIds);
    expect(unique.size).toBe(CONCURRENCY);

    // Each echoed body must match its own response header
    results.forEach(r => {
      expect(r.body.traceId).toBe(r.headers['x-trace-id']);
    });
  });

});
