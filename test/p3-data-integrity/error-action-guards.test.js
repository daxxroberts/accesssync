/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Retry and Mark-resolved must never hide a problem that is    │
 * │  still there.                                                           │
 * │                                                                         │
 * │  Before: "Retry now" / "Retry all active" re-queued errors that fail    │
 * │  the same way and marked them resolved, so they left the panel while    │
 * │  the member was still locked out; and the gym could "Mark resolved" an  │
 * │  error only AccessSync can fix, turning the owner's panel green.        │
 * │  Rules (core/error-guidance.js): a retry that cannot help is refused     │
 * │  (nothing queued, row stays open); an operator cannot dismiss an         │
 * │  AccessSync-owned error; the owner can dismiss anything.                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const request = require('supertest');

// ── Mocks ────────────────────────────────────────────────────────────────────
// One shared add() for every queue instance: errors.js and members.js build
// their own Queue; operator.js imports eventQueue from webhook-processor.
const mockQueueAdd = jest.fn();

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
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
}));
jest.mock('../../core/webhook-processor', () => ({ eventQueue: { add: mockQueueAdd } }));
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
  getTraceId:      jest.fn(() => 'trace-test'),
  getActor:        jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
  runWith:         jest.fn((ctx, fn) => fn()),
  mintTraceId:     jest.fn(() => 'trace-minted'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));

const db      = require('../../db');
const { log } = require('../../core/logger');
const { GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES } = require('../../core/event-routing');

function makeApp(router, mountPath, admin = { clientId: 'c1', userId: 'test-user' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = admin; next(); });
  app.use(mountPath, router);
  return app;
}

/** Every SQL string the route sent, in order. */
function sqlCalls() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}
/** Did the route mark any error_queue row resolved? */
function resolvedAnything() {
  return sqlCalls().some(s => /UPDATE\s+error_queue/i.test(s) && /resolved/i.test(s));
}
function warnEvents() {
  return log.warn.mock.calls.map(c => c[0]);
}


const GRANT = { eventType: 'plan.purchased', payload: { eventType: 'plan.purchased', platformMemberId: 'm1', planId: 'p1' } };
const row = (over = {}) => ({
  id: 'e1', client_id: 'c1', event_type: GRANT.eventType, payload: GRANT.payload,
  error_code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY', http_status: 422, occurred_count: 1, ...over,
});
const WONT_HELP = row();                                                                       // Kisi 422: AccessSync's, Retry cannot help
const GYM_FIX   = row({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null }); // gym's; Retry after fixing
const TEMPORARY = row({ error_code: 'HARDWARE_API_ERROR', http_status: 503 });                // clears itself; Retry works

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue({ id: 'job-1' });
});

const select = (r) => db.query.mockResolvedValueOnce({ rows: [r] });

describe('[P3] admin retry — a retry that cannot help is refused, never "resolved"', () => {
  const adminErrors = () => makeApp(require('../../admin/routes/errors'), '/admin/errors');

  test('single retry of a Kisi 422: 422 + reason retry_wont_help, nothing queued, row stays open', async () => {
    select(WONT_HELP);
    const res = await request(adminErrors()).post('/admin/errors/e1/retry');
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('retry_wont_help');
    expect(res.body.error).toMatch(/fail the same way/);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(warnEvents()).toContain('admin.retry.wont_help');
  });

  test.each([['gym-fixable (retry after the fix)', GYM_FIX], ['temporary (retry works)', TEMPORARY]])(
    'single retry of a %s error is queued as before', async (_label, r) => {
      select(r);
      db.query.mockResolvedValue({ rows: [] });
      const res = await request(adminErrors()).post('/admin/errors/e1/retry');
      expect(res.status).toBe(200);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });

  test('bulk retry: retryable rows are queued, rows that cannot help are SKIPPED with a reason and left open', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT client_id, event_type, payload/.test(sql)) return { rows: [{ e1: WONT_HELP, e2: GYM_FIX, e3: TEMPORARY }[params[0]]] };
      return { rows: [] };
    });
    const res = await request(adminErrors()).post('/admin/errors/bulk-retry').send({ ids: ['e1', 'e2', 'e3'] });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.skippedRows).toEqual([expect.objectContaining({ id: 'e1', reason: 'retry_wont_help' })]);
    // only the two queued rows were marked resolved
    const resolved = db.query.mock.calls.filter(c => /UPDATE error_queue SET status='resolved'/.test(c[0])).map(c => c[1][0]);
    expect(resolved.sort()).toEqual(['e2', 'e3']);
  });

  test('retry from the member page (Debug Center) obeys the same rule', async () => {
    const app = makeApp(require('../../admin/routes/members'), '/admin/members');
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1' }] })      // member_master
      .mockResolvedValueOnce({ rows: [{ id: 'e1', client_id: 'c1', event_type: GRANT.eventType, payload: GRANT.payload, error_code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY', http_status: 422, occurred_count: 1 }] });
    const res = await request(app).post('/admin/members/m-1/retry');
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('retry_wont_help');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
  });
});

describe('[P3] operator routes — same rules, and the gym cannot hide AccessSync-owned errors', () => {
  const operator = (admin) => makeApp(require('../../admin/routes/operator'), '/operator', admin);

  test('operator retry of a Kisi 422 is refused: nothing queued, row left open', async () => {
    select(WONT_HELP);
    const res = await request(operator()).post('/operator/c1/errors/e1/retry');
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('retry_wont_help');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
  });

  test('operator retry of a gym-fixable error still queues', async () => {
    select(GYM_FIX);
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(operator()).post('/operator/c1/errors/e1/retry');
    expect(res.status).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  test('the GYM cannot "Mark resolved" an AccessSync-owned error: 409, row untouched', async () => {
    select(WONT_HELP);
    const res = await request(operator({ role: 'operator', clientId: 'c1' })).post('/operator/c1/errors/e1/dismiss');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('owned_by_accesssync');
    expect(res.body.error).toMatch(/AccessSync support is looking into this/);
    expect(resolvedAnything()).toBe(false);
  });

  test('the gym CAN dismiss errors that are theirs (a fixed key, a mapped plan) or that clear by themselves', async () => {
    for (const r of [GYM_FIX, TEMPORARY]) {
      db.query.mockReset();
      db.query.mockResolvedValueOnce({ rows: [r] }).mockResolvedValueOnce({ rows: [{ id: 'e1', status: 'resolved' }] });
      const res = await request(operator({ role: 'operator', clientId: 'c1' })).post('/operator/c1/errors/e1/dismiss');
      expect(res.status).toBe(200);
      expect(resolvedAnything()).toBe(true);
    }
  });

  test('the OWNER can dismiss an AccessSync-owned error', async () => {
    select(WONT_HELP);
    db.query.mockResolvedValueOnce({ rows: [{ id: 'e1', status: 'resolved' }] });
    const res = await request(operator({ role: 'admin' })).post('/operator/c1/errors/e1/dismiss');
    expect(res.status).toBe(200);
    expect(resolvedAnything()).toBe(true);
  });

  test('an unknown error id is still a 404 (the guard does not change that)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(operator({ role: 'operator', clientId: 'c1' })).post('/operator/c1/errors/nope/dismiss');
    expect(res.status).toBe(404);
  });
});

describe('[P3] every error names its member (error_queue.member_id written as member_master.id)', () => {
  const fs = require('fs');
  const path = require('path');
  test('the errors list, detail and the gym\'s list match member_id against member_master as well as member_access', () => {
    const errorsSrc = fs.readFileSync(path.join(__dirname, '../../admin/routes/errors.js'), 'utf8');
    const operatorSrc = fs.readFileSync(path.join(__dirname, '../../admin/routes/operator.js'), 'utf8');
    const either = /LEFT JOIN member_access ma ON \(ma\.id = eq\.member_id\s+OR \(ma\.member_master_id = eq\.member_id AND ma\.client_id = eq\.client_id\)\)/g;
    expect((errorsSrc.match(either) || []).length).toBe(2);
    expect((operatorSrc.match(either) || []).length).toBe(1);
    expect(errorsSrc).not.toMatch(/LEFT JOIN member_access ma ON ma\.id = eq\.member_id\s*\n/);
    expect(operatorSrc).not.toMatch(/LEFT JOIN member_access ma ON ma\.id = eq\.member_id\s*\n/);
  });
});
