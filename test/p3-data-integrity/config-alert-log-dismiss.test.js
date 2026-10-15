/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  POST /operator/:clientId/alerts/:alertId/dismiss                       │
 * │                                                                          │
 * │  2026-07-15: found that nothing in the codebase EVER wrote               │
 * │  config_alert_log.resolved_at — unlike error_queue (which has a working  │
 * │  dismiss/retry flow), every config alert ever logged reappeared in every │
 * │  nightly digest forever, even after its root cause was long fixed (e.g.  │
 * │  stale notification_delivery_failed rows from before RESEND_API_KEY was  │
 * │  set on Railway). This route is the missing resolution mechanism,        │
 * │  mirroring the existing POST /operator/:clientId/errors/:errorId/dismiss │
 * │  pattern.                                                                │
 * │                                                                          │
 * │  What CANNOT regress:                                                    │
 * │    1. Dismissing sets resolved_at (so the digest's WHERE resolved_at IS  │
 * │       NULL filter excludes it going forward)                             │
 * │    2. client_id scoping — can't dismiss another tenant's alert            │
 * │    3. 404 on a non-existent / already-scoped-out alert id                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(v => `dec-${v}`),
  encryptApiKey: jest.fn(v => `enc-${v}`),
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })),
}));
jest.mock('../../core/diagnostics', () => ({ diagnoseMember: jest.fn(), getTimeline: jest.fn() }));
jest.mock('../../core/reconciliation', () => ({ reconcileMember: jest.fn() }));
jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers: jest.fn(), reactivateLocationMembers: jest.fn(),
}));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ getGroups: jest.fn(), getLocks: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(), findUserByEmail: jest.fn(), createUser: jest.fn(),
  assignRole: jest.fn(), removeRole: jest.fn(),
}));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth:               (_req, _res, next) => next(),
  requireAuthPage:           (_req, _res, next) => next(),
  requireAuthPageOrOperator: (_req, _res, next) => next(),
  requireAuthOrOperator:     (_req, _res, next) => next(),
  requireInviteToken:        (_req, _res, next) => next(),
  signToken:                 jest.fn(() => 'mock-token'),
  signOperatorToken:         jest.fn(() => 'mock-op-token'),
}));
jest.mock('../../core/trace-context', () => ({
  setClientId: jest.fn(), getClientId: jest.fn(), withClient: jest.fn((_id, fn) => fn()),
  getTraceId: jest.fn(() => 'trace-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
  runWith: jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-test'),
}));

const mockRecordActivity = jest.fn();
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: mockRecordActivity }));

const db = require('../../db');

function makeApp(router, mountPath = '/') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { role: 'admin', clientId: 'test-client', userId: 'test-user' }; next(); });
  app.use(mountPath, router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[P3] POST /operator/:clientId/alerts/:alertId/dismiss', () => {
  let app;

  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');
  });

  test('sets resolved_at and scopes the UPDATE by client_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'alert-1', resolved_at: '2026-07-15T00:00:00.000Z' }] });

    const res = await request(app).post('/operator/client-hog/alerts/alert-1/dismiss');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'alert-1', resolved_at: '2026-07-15T00:00:00.000Z' });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE config_alert_log/);
    expect(sql).toMatch(/SET\s+resolved_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND client_id = \$2/);
    expect(params).toEqual(['alert-1', 'client-hog']);
  });

  test('404s when the alert id does not exist (or belongs to another client)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/operator/client-hog/alerts/nonexistent/dismiss');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Alert not found' });
  });

  test('records an activity_event entry on success', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'alert-1', resolved_at: '2026-07-15T00:00:00.000Z' }] });
    await request(app).post('/operator/client-hog/alerts/alert-1/dismiss');
    expect(mockRecordActivity).toHaveBeenCalledWith(
      expect.anything(), 'alert.dismissed', { clientId: 'client-hog', alertId: 'alert-1' }
    );
  });
});

describe('[P3] GET /operator/:clientId/alerts — the gym can read its sync alerts (L17)', () => {
  let app;
  beforeAll(() => { app = makeApp(require('../../admin/routes/operator'), '/operator'); });

  test('each alert carries the digest sentence (naming the member when known) and whether the gym decides it', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'a1', alert_type: 'revoke_holder_lapse_pending', hardware_ref: 'member:wix-9', affected_member_count: null,
        resolved_at: null, created_at: '2026-10-04T09:54:00Z', last_seen_at: null, member_name: 'Pat Example' },
      { id: 'a2', alert_type: 'sweep_repair_pending', hardware_ref: 'member:wix-7', affected_member_count: null,
        resolved_at: null, created_at: '2026-10-04T09:54:00Z', last_seen_at: null, member_name: null },
    ] });
    const res = await request(app).get('/operator/client-hog/alerts');
    expect(res.status).toBe(200);
    const [a1, a2] = res.body.alerts;
    expect(a1.message).toMatch(/^Pat Example /);
    expect(a1.message).toMatch(/nothing was removed/);
    expect(a1.gym_decides).toBe(true);
    expect(a2.message).toMatch(/door access/);
    expect(a2.gym_decides).toBe(false);          // a paying member without access is never "leave it"
  });

  test('scoped to the requested client, member lookups included', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/operator/client-hog/alerts');
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual(['client-hog']);
    expect(sql).toMatch(/WHERE cal\.client_id = \$1/);
    expect(sql).toMatch(/mm\.client_id = cal\.client_id/);
    expect(sql).toMatch(/ma\.client_id = cal\.client_id/);
    expect(sql).toMatch(/cal\.resolved_at IS NULL/);
  });
});
