/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: every admin/operator "Retry" of a failed error_queue row     │
 * │  routes through core/event-routing.js                                   │
 * │                                                                         │
 * │  Business consequence (found 2026-09-10, reconciliation safety pass):   │
 * │    admin/routes/errors.js (single + bulk) and admin/routes/members.js   │
 * │    carried grant = [plan.purchased, payment.recovered,                  │
 * │    booking.confirmed] and sent EVERYTHING ELSE to 'revoke'. Retry on a  │
 * │    failed plan.started grant (delayed-start member) enqueued a REVOKE;  │
 * │    Retry on a non-member row (source_retry_exhausted) also enqueued a   │
 * │    revoke. The row was then marked resolved, hiding it.                 │
 * │    admin/routes/operator.js "Retry now" enqueued a job NAMED after the  │
 * │    event type with the raw payload as data — a shape queue-worker never │
 * │    runs — and also marked the row resolved.                             │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    1. Grant types → 'grant' (incl. plan.started), job data is           │
 * │       { tenantId, standardEvent } with a traceId.                       │
 * │    2. Unroutable event type → nothing queued, row NOT resolved,         │
 * │       422 { error, reason } (single) / skipped + reason (bulk).         │
 * │    3. Unreadable payload (null, bad JSON, array, non-object) → same.    │
 * │    4. PHASE 1 (fix round F1, 2026-09-10): a retry that routes to        │
 * │       'revoke' is REFUSED in every handler — nothing queued, row NOT    │
 * │       resolved, 422 reason 'revoke_retry_disabled' (single) / skipped   │
 * │       (bulk), warn admin.retry.revoke_disabled. Phase 1 enables no new  │
 * │       removal; replaying a stale removal later can take door access     │
 * │       from someone who has since paid. (This overrides the earlier      │
 * │       spec I-9, under which revoke retries were queued as 'revoke'.)    │
 * │                                                                         │
 * │  Uses the REAL core/event-routing.js. DB and BullMQ are mocked.         │
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

function makeApp(router, mountPath) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { clientId: 'c1', userId: 'test-user' }; next(); });
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

const UNROUTABLE_TYPES = [
  ['a non-member row type (source_retry_exhausted)', 'source_retry_exhausted'],
  ['an unknown type',                                'plan.renewed'],
  ['a null event_type',                              null],
  ['the empty string',                               ''],
  ["wrong case 'PLAN.CANCELLED'",                    'PLAN.CANCELLED'],
  ['a raw Wix event name',                           'wixPricingPlans.orderCanceled'],
];

// The exact gym-owner copy every handler returns when it refuses a removal retry.
const REVOKE_RETRY_DISABLED_MESSAGE =
  'Retrying a door-access removal is paused while AccessSync\'s safety checks are rolled out. '
  + 'Nothing was changed — if this person should lose access, remove them in Kisi.';

/** Shared assertions for a refused removal retry (single-row handlers). */
function expectRevokeRefused(res) {
  expect(res.status).toBe(422);
  expect(res.body.reason).toBe('revoke_retry_disabled');
  expect(res.body.error).toBe(REVOKE_RETRY_DISABLED_MESSAGE);
  expect(mockQueueAdd).not.toHaveBeenCalled();
  expect(resolvedAnything()).toBe(false);
  expect(warnEvents()).toContain('admin.retry.revoke_disabled');
  const warn = log.warn.mock.calls.find(c => c[0] === 'admin.retry.revoke_disabled');
  expect(warn[1]).toEqual(expect.objectContaining({ reason: 'revoke_retry_disabled' }));
}

const UNREADABLE_PAYLOADS = [
  ['a null payload',                 null],
  ['unparseable JSON text',          '{"eventType": "plan.purchased"'],
  ['a JSON array (text)',            '[{"eventType":"plan.purchased"}]'],
  ['an array (jsonb)',               [{ eventType: 'plan.purchased' }]],
  ['a JSON string literal (text)',   '"plan.purchased"'],
  ['a number',                       42],
];

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not just clear: refused retries leave the queued UPDATE mock
  // unconsumed, and a leftover Once value would shift the next test's chain.
  db.query.mockReset();
  mockQueueAdd.mockReset();
  mockQueueAdd.mockResolvedValue({ id: 'job-1' });
});

// ─────────────────────────────────────────────────────────────────────────────
// admin/routes/errors.js — POST /admin/errors/:id/retry
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] admin retry routing — POST /admin/errors/:id/retry', () => {
  let app;
  beforeAll(() => { app = makeApp(require('../../admin/routes/errors'), '/admin/errors'); });

  function mockRow(eventType, payload) {
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: eventType, payload }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE error_queue (success path only)
  }

  test.each(GRANT_EVENT_TYPES)("'%s' → a 'grant' job, row resolved", async (eventType) => {
    mockRow(eventType, JSON.stringify({ eventType, platformMemberId: 'pm-1', traceId: 't-1' }));
    const res = await request(app).post('/admin/errors/err-1/retry');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: 'grant' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('grant');
    expect(data).toEqual({ tenantId: 'c1', standardEvent: { eventType, platformMemberId: 'pm-1', traceId: 't-1' } });
    expect(opts.jobId).toMatch(/^admin-retry-err-1-\d+$/);
    expect(resolvedAnything()).toBe(true);
  });

  // Phase 1 F1 — was "'%s' → a 'revoke' job, row resolved" (spec I-9). A removal
  // retry now enqueues nothing and leaves the row open.
  test.each(REVOKE_EVENT_TYPES)("PHASE 1: '%s' (a removal) → 422 revoke_retry_disabled, nothing queued, row NOT resolved", async (eventType) => {
    mockRow(eventType, { eventType, platformMemberId: 'pm-1', traceId: 't-1' });
    const res = await request(app).post('/admin/errors/err-1/retry');

    expectRevokeRefused(res);
    expect(db.query).toHaveBeenCalledTimes(1); // the SELECT only
    const warn = log.warn.mock.calls.find(c => c[0] === 'admin.retry.revoke_disabled');
    expect(warn[1]).toEqual(expect.objectContaining({ errorId: 'err-1', eventType, route: 'admin.errors.retry' }));
  });

  test("REGRESSION: a failed plan.started grant is retried as a GRANT, never a revoke", async () => {
    mockRow('plan.started', JSON.stringify({ eventType: 'plan.started', traceId: 't-1' }));
    await request(app).post('/admin/errors/err-1/retry');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('grant');
  });

  test('mints a traceId when the saved event has none (success path unchanged)', async () => {
    mockRow('plan.purchased', JSON.stringify({ eventType: 'plan.purchased' }));
    await request(app).post('/admin/errors/err-1/retry');
    expect(mockQueueAdd.mock.calls[0][1].standardEvent.traceId).toBe('trace-minted');
  });

  test.each(UNROUTABLE_TYPES)('%s → 422, nothing queued, row NOT resolved', async (_label, eventType) => {
    mockRow(eventType, JSON.stringify({ eventType, traceId: 't-1' }));
    const res = await request(app).post('/admin/errors/err-1/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unroutable_event_type');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toMatch(/Nothing was queued/);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1); // the SELECT only
    expect(warnEvents()).toContain('admin.retry.unroutable_event_type');
  });

  test.each(UNREADABLE_PAYLOADS)('%s → 422, nothing queued, row NOT resolved', async (_label, payload) => {
    mockRow('plan.purchased', payload);
    const res = await request(app).post('/admin/errors/err-1/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unreadable_payload');
    expect(typeof res.body.error).toBe('string');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(warnEvents()).toContain('admin.retry.unreadable_payload');
  });

  test('an unreadable payload on a REVOKE row is refused too — never replayed blind', async () => {
    mockRow('plan.cancelled', 'not json at all');
    const res = await request(app).post('/admin/errors/err-1/retry');
    expect(res.status).toBe(422);
    // The removal refusal is checked first: it applies whatever the payload says.
    expect(res.body.reason).toBe('revoke_retry_disabled');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
  });

  test('unknown error id → 404 (unchanged)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/admin/errors/missing/retry');
    expect(res.status).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// admin/routes/errors.js — POST /admin/errors/bulk-retry
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] admin retry routing — POST /admin/errors/bulk-retry', () => {
  let app;
  beforeAll(() => { app = makeApp(require('../../admin/routes/errors'), '/admin/errors'); });

  test('routes each row on its own: grants queued; removals, unroutable and unreadable skipped and left open', async () => {
    // Per id the route does SELECT, then (only when queued) UPDATE.
    // Phase 1 F1: row d (plan.cancelled — a removal) used to be queued as
    // 'revoke' and resolved; it is now skipped, so it has no UPDATE mock.
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: 'plan.started', payload: '{"eventType":"plan.started","traceId":"t-a"}' }] }) // a: SELECT
      .mockResolvedValueOnce({ rowCount: 1 })                                                                                                    // a: UPDATE
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: 'source_retry_exhausted', payload: '{"sourceId":"s1"}' }] })              // b: SELECT
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: 'plan.purchased', payload: null }] })                                      // c: SELECT
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: 'plan.cancelled', payload: { eventType: 'plan.cancelled', traceId: 't-d' } }] }) // d: SELECT
      .mockResolvedValueOnce({ rows: [] });                                                                                                      // e: SELECT (missing)

    const res = await request(app)
      .post('/admin/errors/bulk-retry')
      .send({ ids: ['a', 'b', 'c', 'd', 'e'] });

    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped).toBe(3);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors).toEqual([]);
    expect(res.body.skippedRows).toEqual([
      expect.objectContaining({ id: 'b', reason: 'unroutable_event_type' }),
      expect.objectContaining({ id: 'c', reason: 'unreadable_payload' }),
      { id: 'd', reason: 'revoke_retry_disabled', error: REVOKE_RETRY_DISABLED_MESSAGE },
    ]);

    // Only the grant was enqueued — never a revoke.
    expect(mockQueueAdd.mock.calls.map(c => c[0])).toEqual(['grant']);
    expect(mockQueueAdd.mock.calls[0][1]).toEqual({ tenantId: 'c1', standardEvent: { eventType: 'plan.started', traceId: 't-a' } });

    // Only the queued row was resolved.
    const resolvedIds = db.query.mock.calls
      .filter(c => /UPDATE\s+error_queue/i.test(c[0]))
      .map(c => c[1][0]);
    expect(resolvedIds).toEqual(['a']);

    expect(warnEvents()).toEqual(expect.arrayContaining([
      'admin.retry.unroutable_event_type', 'admin.retry.unreadable_payload', 'admin.retry.revoke_disabled',
    ]));
  });

  test.each(REVOKE_EVENT_TYPES)("PHASE 1: a bulk batch of '%s' rows queues nothing, resolves nothing, counts each as skipped", async (eventType) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: eventType, payload: { eventType, traceId: 't-x' } }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: eventType, payload: JSON.stringify({ eventType, traceId: 't-y' }) }] });
    const res = await request(app).post('/admin/errors/bulk-retry').send({ ids: ['x', 'y'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: 0, skipped: 2, failed: 0 });
    expect(res.body.skippedRows).toEqual([
      { id: 'x', reason: 'revoke_retry_disabled', error: REVOKE_RETRY_DISABLED_MESSAGE },
      { id: 'y', reason: 'revoke_retry_disabled', error: REVOKE_RETRY_DISABLED_MESSAGE },
    ]);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(warnEvents().filter(e => e === 'admin.retry.revoke_disabled')).toHaveLength(2);
  });

  test('a batch of only unroutable rows queues nothing and resolves nothing', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: 'source_retry_exhausted', payload: '{}' }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', event_type: null, payload: '{}' }] });
    const res = await request(app).post('/admin/errors/bulk-retry').send({ ids: ['x', 'y'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: 0, skipped: 2, failed: 0 });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
  });

  test('empty ids → 400 (unchanged)', async () => {
    const res = await request(app).post('/admin/errors/bulk-retry').send({ ids: [] });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// admin/routes/members.js — POST /admin/members/:id/retry
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] admin retry routing — POST /admin/members/:id/retry', () => {
  let app;
  beforeAll(() => { app = makeApp(require('../../admin/routes/members'), '/admin/members'); });

  function mockLatestFailed(eventType, payload) {
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1' }] }) // member_master lookup
      .mockResolvedValueOnce({ rows: [{ id: 'err-9', client_id: 'c1', event_type: eventType, payload }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE (success path only)
  }

  test("REGRESSION: plan.started → 'grant', never 'revoke'", async () => {
    mockLatestFailed('plan.started', '{"eventType":"plan.started","traceId":"t-1"}');
    const res = await request(app).post('/admin/members/mm-1/retry');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, queued: 'grant', errorId: 'err-9' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('grant');
    expect(data).toEqual({ tenantId: 'c1', standardEvent: { eventType: 'plan.started', traceId: 't-1' } });
    expect(opts.jobId).toMatch(/^admin-member-retry-mm-1-\d+$/);
    expect(resolvedAnything()).toBe(true);
  });

  // Phase 1 F1 — was "'%s' → 'revoke'" (spec I-9).
  test.each(REVOKE_EVENT_TYPES)("PHASE 1: '%s' (a removal) → 422 revoke_retry_disabled, nothing queued, row NOT resolved", async (eventType) => {
    mockLatestFailed(eventType, { eventType, traceId: 't-1' });
    const res = await request(app).post('/admin/members/mm-1/retry');

    expectRevokeRefused(res);
    expect(res.body.errorId).toBe('err-9');
    expect(db.query).toHaveBeenCalledTimes(2); // member lookup + error_queue SELECT only
    const warn = log.warn.mock.calls.find(c => c[0] === 'admin.retry.revoke_disabled');
    expect(warn[1]).toEqual(expect.objectContaining({ errorId: 'err-9', eventType, route: 'admin.members.retry' }));
  });

  test('PHASE 1: an unreadable payload on a removal row still gets the removal refusal', async () => {
    mockLatestFailed('member.deleted', null);
    const res = await request(app).post('/admin/members/mm-1/retry');
    expectRevokeRefused(res);
  });

  test.each(UNROUTABLE_TYPES)('%s → 422, nothing queued, row NOT resolved', async (_label, eventType) => {
    mockLatestFailed(eventType, '{"traceId":"t-1"}');
    const res = await request(app).post('/admin/members/mm-1/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unroutable_event_type');
    expect(typeof res.body.error).toBe('string');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(warnEvents()).toContain('admin.retry.unroutable_event_type');
  });

  test.each(UNREADABLE_PAYLOADS)('%s → 422, nothing queued, row NOT resolved', async (_label, payload) => {
    mockLatestFailed('plan.purchased', payload);
    const res = await request(app).post('/admin/members/mm-1/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unreadable_payload');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(warnEvents()).toContain('admin.retry.unreadable_payload');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// admin/routes/operator.js — POST /operator/:clientId/errors/:errorId/retry
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] admin retry routing — operator "Retry now" (POST /operator/:clientId/errors/:errorId/retry)', () => {
  let app;
  beforeAll(() => { app = makeApp(require('../../admin/routes/operator'), '/operator'); });

  function mockRow(eventType, payload) {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'err-5', client_id: 'c1', event_type: eventType, payload }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE (success path only)
  }

  test.each(GRANT_EVENT_TYPES)("'%s' → a 'grant' job shaped { tenantId, standardEvent }", async (eventType) => {
    mockRow(eventType, { eventType, platformMemberId: 'pm-1', traceId: 't-1' });
    const res = await request(app).post('/operator/c1/errors/err-5/retry');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: true });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    // The old bug: the job was NAMED after the event type ('plan.purchased'),
    // with the raw payload as data — queue-worker never runs that.
    expect(name).toBe('grant');
    expect(data).toEqual({ tenantId: 'c1', standardEvent: { eventType, platformMemberId: 'pm-1', traceId: 't-1' } });
    expect(opts).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    expect(resolvedAnything()).toBe(true);
  });

  // Phase 1 F1 — this assertion used to pin the OLD behaviour (spec I-9): a
  // removal retry was queued as a 'revoke' job. Phase 1 enables no new removal,
  // so the operator "Retry now" on a removal row now refuses and leaves it open.
  test.each(REVOKE_EVENT_TYPES)("PHASE 1: '%s' (a removal) → 422 revoke_retry_disabled, nothing queued, row NOT resolved", async (eventType) => {
    mockRow(eventType, { eventType, traceId: 't-1' });
    const res = await request(app).post('/operator/c1/errors/err-5/retry');

    expectRevokeRefused(res);
    expect(db.query).toHaveBeenCalledTimes(1); // the SELECT only
    const warn = log.warn.mock.calls.find(c => c[0] === 'admin.retry.revoke_disabled');
    expect(warn[1]).toEqual(expect.objectContaining({
      clientId: 'c1', errorId: 'err-5', eventType, route: 'operator.errors.retry',
    }));
  });

  test('PHASE 1: an unreadable payload on a removal row still gets the removal refusal', async () => {
    mockRow('payment.failed', 'not json');
    const res = await request(app).post('/operator/c1/errors/err-5/retry');
    expectRevokeRefused(res);
  });

  test('parses a text payload and mints a traceId when absent', async () => {
    mockRow('plan.purchased', '{"eventType":"plan.purchased","platformMemberId":"pm-1"}');
    await request(app).post('/operator/c1/errors/err-5/retry');
    expect(mockQueueAdd.mock.calls[0][1]).toEqual({
      tenantId: 'c1',
      standardEvent: { eventType: 'plan.purchased', platformMemberId: 'pm-1', traceId: 'trace-minted' },
    });
  });

  test('keeps an existing traceId', async () => {
    mockRow('plan.purchased', { eventType: 'plan.purchased', traceId: 't-keep' });
    await request(app).post('/operator/c1/errors/err-5/retry');
    expect(mockQueueAdd.mock.calls[0][1].standardEvent.traceId).toBe('t-keep');
  });

  test.each(UNROUTABLE_TYPES)('%s → 422, nothing queued, row NOT resolved', async (_label, eventType) => {
    mockRow(eventType, { eventType, traceId: 't-1' });
    const res = await request(app).post('/operator/c1/errors/err-5/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unroutable_event_type');
    expect(typeof res.body.error).toBe('string');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(warnEvents()).toContain('admin.retry.unroutable_event_type');
  });

  test.each(UNREADABLE_PAYLOADS)('%s → 422, nothing queued, row NOT resolved', async (_label, payload) => {
    mockRow('plan.purchased', payload);
    const res = await request(app).post('/operator/c1/errors/err-5/retry');

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('unreadable_payload');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(resolvedAnything()).toBe(false);
    expect(warnEvents()).toContain('admin.retry.unreadable_payload');
  });

  test('unknown error id → 404 (unchanged)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/operator/c1/errors/nope/retry');
    expect(res.status).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// admin-errors.ejs — the UI must not report a refused retry as "Requeued"
// (source text: the view is browser JS, not requireable)
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] admin retry routing — admin-errors.ejs surfaces refusals', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'admin', 'views', 'pages', 'admin-errors.ejs'), 'utf8');

  function fnBody(name) {
    const start = src.indexOf('function ' + name + '(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\n    function ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  test('single Retry checks the response status before saying "Requeued"', () => {
    const body = fnBody('adminRetry');
    expect(body).toMatch(/!res\.ok/);
    expect(body).toMatch(/res\.body\.error/);
    expect(body.indexOf('!res.ok')).toBeLessThan(body.indexOf("'Requeued'"));
  });

  test('bulk Retry reports the skipped count', () => {
    const body = fnBody('bulkRetryAll');
    expect(body).toMatch(/!res\.ok/);
    expect(body).toMatch(/\.skipped/);
  });

  test('server error text is HTML-escaped before it reaches the toast (showToast uses innerHTML)', () => {
    expect(fnBody('adminRetry')).toMatch(/showToast\('error',\s*esc\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Browser-side retry UI, run for real (fix round F10, 2026-09-10).
// The views are browser JS, not requireable, so each function is lifted out of
// its source file and executed against stubbed globals. This exercises the
// actual code the gym owner's browser runs — not a regex over it.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.join(__dirname, '..', '..');
function readRepoFile(...parts) { return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8'); }

/** Source text of `function <name>(…) { … }` (brace-matched). */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('function ' + name + ' has unbalanced braces');
}

/** Run the named functions from `src` with `env` as their globals; returns them. */
function liftFunctions(src, names, env) {
  const code = names.map(n => extractFunction(src, n)).join('\n')
    + '\nreturn { ' + names.join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(env), code)(...Object.values(env));
}

/** A fetch Response stand-in. body === undefined → non-JSON body. */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(body)),
  };
}

// Node drains every queued microtask before the next macrotask, so one
// setImmediate turn settles the whole promise chain.
const settle = () => new Promise(r => setImmediate(r));

// The real operator-nav.js esc(): errors.ejs's showToast writes innerHTML.
const realEsc = liftFunctions(readRepoFile('admin', 'public', 'operator-nav.js'), ['esc'], {}).esc;

describe('[P3] admin retry routing — operator Errors page (errors.ejs) surfaces refusals (F10)', () => {
  const src = readRepoFile('admin', 'views', 'pages', 'errors.ejs');

  function page({ response, errors } = {}) {
    const toasts = [];
    const calls  = { loadErrors: 0, loadSummary: 0, warned: [] };
    const retryAllBtn = { disabled: true, textContent: 'Retrying…' };
    const apiFetch = jest.fn(() => Promise.resolve(response));
    const fns = liftFunctions(src, ['readJsonResponse', 'retryOne', 'retryAll'], {
      _clientId:   'c1',
      _errors:     errors || [],
      apiFetch,
      showToast:   (type, msg) => toasts.push({ type, msg }),
      esc:         realEsc,
      loadErrors:  () => { calls.loadErrors++; },
      loadSummary: () => { calls.loadSummary++; },
      document:    { getElementById: () => retryAllBtn },
      console:     { warn: (...a) => calls.warned.push(a) },
    });
    return { ...fns, toasts, calls, apiFetch, retryAllBtn };
  }

  test('Retry now on a refused REMOVAL shows the server’s explanation — never "Requeued"', async () => {
    const p = page({ response: fakeResponse(422, { error: REVOKE_RETRY_DISABLED_MESSAGE, reason: 'revoke_retry_disabled' }) });
    const btn = { disabled: false, textContent: 'Retry now' };
    p.retryOne('err-5', btn);
    await settle();

    expect(p.apiFetch).toHaveBeenCalledWith('/operator/c1/errors/err-5/retry', { method: 'POST' });
    expect(p.toasts).toEqual([{ type: 'error', msg: REVOKE_RETRY_DISABLED_MESSAGE }]);
    expect(p.toasts.some(t => /Requeued/.test(t.msg))).toBe(false);
    expect(btn).toEqual({ disabled: false, textContent: 'Retry now' }); // usable again
    expect(p.calls.loadErrors).toBe(0); // the row did not change — nothing to reload
  });

  test('Retry now success still says "Requeued" and reloads', async () => {
    const p = page({ response: fakeResponse(200, { queued: true }) });
    p.retryOne('err-5', { disabled: false, textContent: 'Retry now' });
    await settle();
    expect(p.toasts).toEqual([{ type: 'success', msg: 'Requeued — AccessSync will retry provisioning' }]);
    expect(p.calls.loadErrors).toBe(1);
    expect(p.calls.loadSummary).toBe(1);
  });

  test('server error text is HTML-escaped before it reaches the innerHTML toast', async () => {
    const p = page({ response: fakeResponse(422, { error: '<img src=x onerror=alert(1)>', reason: 'unroutable_event_type' }) });
    p.retryOne('err-5', { disabled: false, textContent: 'Retry now' });
    await settle();
    expect(p.toasts[0].type).toBe('error');
    expect(p.toasts[0].msg).not.toContain('<img');
    expect(p.toasts[0].msg).toContain('&lt;img');
  });

  test('a non-JSON error body falls back to the HTTP status, still no "Requeued"', async () => {
    const p = page({ response: fakeResponse(500, undefined) });
    p.retryOne('err-5', { disabled: false, textContent: 'Retry now' });
    await settle();
    expect(p.toasts).toEqual([{ type: 'error', msg: 'Retry failed (HTTP 500)' }]);
  });

  test('Retry all: the toast carries the skipped count and explains skipped removals', async () => {
    const p = page({
      errors: [{ id: 'a', status: 'failed' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'failed' }, { id: 'z', status: 'resolved' }],
      response: fakeResponse(200, {
        queued: 1, failed: 0, skipped: 2, errors: [],
        skippedRows: [
          { id: 'b', reason: 'revoke_retry_disabled', error: REVOKE_RETRY_DISABLED_MESSAGE },
          { id: 'c', reason: 'unroutable_event_type', error: 'x' },
        ],
      }),
    });
    p.retryAll();
    await settle();

    const [, opts] = p.apiFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ ids: ['a', 'b', 'c'] }); // only open rows
    expect(p.toasts).toHaveLength(1);
    expect(p.toasts[0].type).toBe('info'); // not a plain success when rows were skipped
    expect(p.toasts[0].msg).toMatch(/^Queued 1 for retry/);
    expect(p.toasts[0].msg).toMatch(/skipped 2/);
    expect(p.toasts[0].msg).toMatch(/Door-access removals can’t be retried yet — nothing was changed/);
    expect(p.toasts[0].msg).toMatch(/remove them in Kisi/);
    expect(p.retryAllBtn).toEqual({ disabled: false, textContent: 'Retry all active' });
  });

  test('Retry all with nothing skipped stays a plain success', async () => {
    const p = page({
      errors: [{ id: 'a', status: 'failed' }],
      response: fakeResponse(200, { queued: 1, failed: 0, skipped: 0, errors: [], skippedRows: [] }),
    });
    p.retryAll();
    await settle();
    expect(p.toasts).toEqual([{ type: 'success', msg: 'Queued 1 for retry' }]);
  });

  test('Retry all: a non-2xx response shows the server’s error, not "Queued 0"', async () => {
    const p = page({
      errors: [{ id: 'a', status: 'failed' }],
      response: fakeResponse(403, { error: 'Forbidden for this account' }),
    });
    p.retryAll();
    await settle();
    expect(p.toasts).toEqual([{ type: 'error', msg: 'Forbidden for this account' }]);
  });
});

describe('[P3] admin retry routing — member incident drawer surfaces refusals (F10)', () => {
  const src = readRepoFile('admin', 'public', 'member-incident-drawer.js');

  function drawer(response) {
    const toasts = [];
    const btn = { disabled: false, textContent: '↻ Retry now' };
    const onActionDone = jest.fn();
    const fetchImpl = jest.fn(() => Promise.resolve(response));
    const { onRetry } = liftFunctions(src, ['onRetry'], {
      state:      { errorId: 'err-5', clientId: 'c1', onActionDone },
      document:   { getElementById: () => btn },
      fetch:      fetchImpl,
      showToast:  (msg, ms) => toasts.push({ msg, ms }),
      fetchAll:   () => {},
      setTimeout: () => {},
    });
    return { onRetry, toasts, btn, onActionDone, fetchImpl };
  }

  test('a refused REMOVAL retry shows the server’s explanation instead of "try again"', async () => {
    const d = drawer(fakeResponse(422, { error: REVOKE_RETRY_DISABLED_MESSAGE, reason: 'revoke_retry_disabled' }));
    d.onRetry();
    await settle();

    expect(d.fetchImpl).toHaveBeenCalledWith('/operator/c1/errors/err-5/retry', { method: 'POST', credentials: 'include' });
    expect(d.toasts).toHaveLength(1);
    expect(d.toasts[0].msg).toBe(REVOKE_RETRY_DISABLED_MESSAGE);
    expect(d.toasts[0].msg).not.toMatch(/try again|Requeued/);
    expect(d.toasts[0].ms).toBeGreaterThan(2200); // long enough to read
    expect(d.onActionDone).not.toHaveBeenCalled();
    expect(d.btn).toEqual({ disabled: false, textContent: '↻ Retry now' });
  });

  test('success is unchanged: "Requeued", and the page is told', async () => {
    const d = drawer(fakeResponse(200, { queued: true }));
    d.onRetry();
    await settle();
    expect(d.toasts.map(t => t.msg)).toEqual(['Requeued — AccessSync will retry provisioning']);
    expect(d.onActionDone).toHaveBeenCalledWith('retry');
  });

  test('a non-JSON error body falls back to the HTTP status', async () => {
    const d = drawer(fakeResponse(502, undefined));
    d.onRetry();
    await settle();
    expect(d.toasts.map(t => t.msg)).toEqual(['Retry failed (HTTP 502)']);
  });

  test('the drawer toast writes textContent, never innerHTML (server text is not escaped there)', () => {
    const body = extractFunction(src, 'showToast');
    expect(body).toMatch(/\.textContent\s*=\s*msg/);
    expect(body).not.toMatch(/innerHTML/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dashboard.ejs Sync button — reasonMap (fix round F14). Lives here because it
// is the same "don't mislabel a refusal" concern and this file owns the
// lift-and-run harness.
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] dashboard Sync button — aborted-sync wording (F14)', () => {
  const { resultMessage } = liftFunctions(readRepoFile('admin', 'views', 'pages', 'dashboard.ejs'), ['resultMessage'], {});

  test("reason 'locked' (another sync holds this gym's lock) is info, not an error", () => {
    expect(resultMessage({ ok: true, granted: 0, revoked: 0, aborted: true, reason: 'locked' }, true))
      .toEqual({ text: 'A sync is already running for this gym — try again in a minute', kind: 'info' });
  });

  test('existing reasons keep their wording and stay errors', () => {
    expect(resultMessage({ ok: true, aborted: true, reason: 'wix_api_unavailable' }, true))
      .toEqual({ text: 'Wix API unreachable — check your Wix API key', kind: 'error' });
    expect(resultMessage({ ok: true, aborted: true, reason: 'hardware_api_unavailable' }, true))
      .toEqual({ text: 'Door system unreachable — check your hardware API key', kind: 'error' });
  });

  test('an unmapped reason (including an inherited property name) falls back to a readable error', () => {
    expect(resultMessage({ ok: true, aborted: true, reason: 'brand_new' }, true))
      .toEqual({ kind: 'error', text: 'Sync aborted — brand_new' });
    expect(resultMessage({ ok: true, aborted: true, reason: 'constructor' }, true))
      .toEqual({ kind: 'error', text: 'Sync aborted — constructor' });
    expect(resultMessage({ ok: true, aborted: true }, true))
      .toEqual({ kind: 'error', text: 'Sync aborted — unknown' });
  });

  test('non-aborted results are unchanged', () => {
    expect(resultMessage({ ok: true, granted: 2, revoked: 0 }, true)).toEqual({ kind: 'success', text: '2 granted · 0 revoked' });
    expect(resultMessage({ ok: true, granted: 0, revoked: 0 }, true)).toEqual({ kind: 'success', text: 'Everything is in sync' });
    expect(resultMessage({ error: 'Sync failed' }, false)).toEqual({ kind: 'error', text: 'Sync failed' });
  });
});
