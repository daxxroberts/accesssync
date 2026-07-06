/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Member Hub synthetic events write the correct actor to the  │
 * │  activity log (commit 727621c, INCIDENT 2026-07-02 remediation).       │
 * │                                                                         │
 * │  The bug this guards: the submit route read req.operator (never set    │
 * │  anywhere — dead read) and req.admin.actorType (the admin JWT payload  │
 * │  carries .role, not .actorType), so every synthetic grant was logged   │
 * │  with the wrong actor. The fix reads req.admin.role / req.admin.email  │
 * │  with an ADMIN_ALLOWED_EMAIL → holderId fallback chain.                │
 * │                                                                         │
 * │  recordSyntheticOrigin() is setImmediate fire-and-forget — each test   │
 * │  flushes the immediate queue after the response before asserting.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Shared mocks (same scaffold as multi-member-new-schema.test.js) ──────────

jest.mock('../../db', () => ({ query: jest.fn() }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: mockQueueAdd },
}));

jest.mock('../../core/trace-context', () => ({
  mintTraceId:     jest.fn(() => 'trace-actor-test'),
  getTraceId:      jest.fn(() => 'trace-actor-test'),
  getActor:        jest.fn(() => ({ type: 'test', id: 'test' })),
  setTraceContext: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const db = require('../../db');

/**
 * @param {Object|null} adminPayload  value for req.admin (null = no admin on the
 *                                    request, e.g. operator-token path)
 */
function makeApp(adminPayload) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (adminPayload) req.admin = adminPayload;
    next();
  });
  const router = require('../../admin/routes/multi-member');
  app.use('/', router);
  return app;
}

/** Flush the setImmediate queue so recordSyntheticOrigin's writes land. */
async function flushImmediates() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

function findInsert(table) {
  return db.query.mock.calls.find(
    c => typeof c[0] === 'string' && c[0].includes(`INSERT INTO ${table}`)
  );
}

const HOLDER_ID = 'holder-master-uuid';
const CLIENT_ID = 'c1';

/** Query sequence for POST /api/multi-member/submit with one draft. */
function mockSubmitHappyPath() {
  db.query
    // 1. drafts SELECT
    .mockResolvedValueOnce({ rows: [{
      access_id:          'sub-access-1',
      platform_member_id: 'wix-holder-1###asab12cd',
      first_name:         'Drew',
      last_name:          'Roberts',
      email:              'drew@test.com',
      phone:              '555-0100',
      source_id:          'src-1',
      plan_mapping_id:    'mapping-1',
      source_plan_id:     'plan-1',
    }] })
    // 2. UPDATE member_access_sources draft → pending_hardware
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  // Default for the fire-and-forget trace_context / activity_event INSERTs.
  db.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/multi-member/submit — actor resolution chain
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] synthetic-origin actor — submit (sub_member.grant_queued)', () => {
  test('admin with email: actor_type from role, actor_id from email', async () => {
    const app = makeApp({ role: 'admin', email: 'admin@test.com' });
    mockSubmitHappyPath();

    const res = await request(app)
      .post('/api/multi-member/submit')
      .send({ holderId: HOLDER_ID, clientId: CLIENT_ID });
    expect(res.status).toBe(200);
    await flushImmediates();

    const activityInsert = findInsert('activity_event');
    expect(activityInsert).toBeDefined();
    const [, params] = activityInsert;
    // (client_id, action, actor_type, actor_id, trace_id, diff)
    expect(params[0]).toBe(CLIENT_ID);
    expect(params[1]).toBe('sub_member.grant_queued');
    expect(params[2]).toBe('admin');
    expect(params[3]).toBe('admin@test.com');
    expect(params[4]).toBe('trace-actor-test');
    expect(JSON.parse(params[5])).toMatchObject({ subMemberId: 'sub-access-1', planId: 'plan-1' });
  });

  test('admin without email: actor_id falls back to ADMIN_ALLOWED_EMAIL', async () => {
    const prev = process.env.ADMIN_ALLOWED_EMAIL;
    process.env.ADMIN_ALLOWED_EMAIL = 'owner@test.com';
    try {
      const app = makeApp({ role: 'admin' }); // JWT payload with no email claim
      mockSubmitHappyPath();

      const res = await request(app)
        .post('/api/multi-member/submit')
        .send({ holderId: HOLDER_ID, clientId: CLIENT_ID });
      expect(res.status).toBe(200);
      await flushImmediates();

      const [, params] = findInsert('activity_event');
      expect(params[2]).toBe('admin');
      expect(params[3]).toBe('owner@test.com');
    } finally {
      if (prev === undefined) delete process.env.ADMIN_ALLOWED_EMAIL;
      else process.env.ADMIN_ALLOWED_EMAIL = prev;
    }
  });

  test('no req.admin at all: actor_type=operator, actor_id=holderId (last fallback)', async () => {
    const app = makeApp(null);
    mockSubmitHappyPath();

    const res = await request(app)
      .post('/api/multi-member/submit')
      .send({ holderId: HOLDER_ID, clientId: CLIENT_ID });
    expect(res.status).toBe(200);
    await flushImmediates();

    const [, params] = findInsert('activity_event');
    expect(params[2]).toBe('operator');
    expect(params[3]).toBe(HOLDER_ID);
  });

  test('trace_context row seeds entry_point=member-hub with the same actor', async () => {
    const app = makeApp({ role: 'admin', email: 'admin@test.com' });
    mockSubmitHappyPath();

    await request(app)
      .post('/api/multi-member/submit')
      .send({ holderId: HOLDER_ID, clientId: CLIENT_ID });
    await flushImmediates();

    const traceInsert = findInsert('trace_context');
    expect(traceInsert).toBeDefined();
    const [sql, params] = traceInsert;
    expect(sql).toMatch(/'member-hub'/);
    // (trace_id, client_id, actor_type, actor_id)
    expect(params).toEqual(['trace-actor-test', CLIENT_ID, 'admin', 'admin@test.com']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/multi-member/members/:subId — remove path actor
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] synthetic-origin actor — remove (sub_member.revoke_queued)', () => {
  test('hardware-provisioned removal logs actor_type=member-hub, actor_id=subId', async () => {
    const app = makeApp({ role: 'admin', email: 'admin@test.com' });
    db.query
      // 1. sub-member lookup
      .mockResolvedValueOnce({ rows: [{
        access_id:          'sub-access-1',
        access_status:      'active',
        source_status:      'active',
        hardware_user_id:   '99001',
        member_master_id:   'mm-sub-1',
        platform_member_id: 'wix-holder-1###asab12cd',
        client_id:          CLIENT_ID,
        source_plan_id:     'plan-1',
      }] })
      // 2. standardAdapter.markSubMemberRemoving (same db mock via module registry)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/multi-member/members/sub-access-1');
    expect(res.status).toBe(200);
    await flushImmediates();

    const [, params] = findInsert('activity_event');
    expect(params[1]).toBe('sub_member.revoke_queued');
    expect(params[2]).toBe('member-hub');
    expect(params[3]).toBe('sub-access-1');
    expect(JSON.parse(params[5])).toMatchObject({ subMemberId: 'sub-access-1', planId: 'plan-1' });
  });
});
