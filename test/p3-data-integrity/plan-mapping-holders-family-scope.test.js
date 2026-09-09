/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: "Members on this plan" must not show unrelated people        │
 * │  as each other's Holder                                                 │
 * │                                                                         │
 * │  Builder-reported 2026-09-09: Daxx's own ongoing test membership on     │
 * │  House of Gains' live "Student" plan showed up as "Holder" alongside    │
 * │  a real, unrelated buyer (Dominick Burkett) in the Members page drawer  │
 * │  — even though neither has a sub_master_id pointing at the other. They  │
 * │  just both independently hold active access via the same plan_mappings │
 * │  row (same plan type, same door group), which is not a family/holder   │
 * │  relationship.                                                         │
 * │                                                                         │
 * │  GET /operator/:clientId/plan-mappings/:mappingId/holders now accepts  │
 * │  an optional ?accessId= that scopes the roster to that one access      │
 * │  row's real holder/sub-member family. Omitting it preserves the        │
 * │  original full-mapping-roster behavior, which the Plan Mapping page's  │
 * │  multi-member occupancy view still legitimately needs.                 │
 * │                                                                         │
 * │  Kept in its own file/suite (not admin-routes-new-schema.test.js): that │
 * │  file's giant shared `app`/`beforeAll` fixture and long test sequence   │
 * │  leaves state that makes this endpoint hang under `express-rate-limit` │
 * │  when run after certain other tests — a pre-existing test-suite         │
 * │  isolation issue, unrelated to this endpoint's own correctness (proven  │
 * │  clean in a standalone run). Full isolation here sidesteps it rather    │
 * │  than trying to fix that shared file's hygiene as a side effect.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((v) => `dec-${v}`),
  encryptApiKey: jest.fn((v) => `enc-${v}`),
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })),
}));
jest.mock('../../core/diagnostics', () => ({
  diagnoseMember: jest.fn(),
  getTimeline: jest.fn(),
}));
jest.mock('../../core/reconciliation', () => ({
  reconcileMember: jest.fn(),
}));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers: jest.fn(),
  reactivateLocationMembers: jest.fn(),
}));
jest.mock('../../admin/middleware/audit', () => ({
  logAdminAction: jest.fn(),
}));
jest.mock('../../adapters/kisi/kisi-connector', () => ({
  getGroups: jest.fn(),
  getLocks: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(),
  findUserByEmail: jest.fn(),
  createUser: jest.fn(),
  assignRole: jest.fn(),
  removeRole: jest.fn(),
}));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAuthPage: (_req, _res, next) => next(),
  requireAuthPageOrOperator: (_req, _res, next) => next(),
  requireAuthOrOperator: (_req, _res, next) => next(),
  requireInviteToken: (_req, _res, next) => next(),
  signToken: jest.fn(() => 'mock-token'),
  signOperatorToken: jest.fn(() => 'mock-op-token'),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-test'),
  getActor: jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
}));
jest.mock('../../admin/middleware/activity', () => ({
  recordActivity: jest.fn(),
}));

const db = require('../../db');

function makeApp() {
  const operatorRouter = require('../../admin/routes/operator');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { clientId: 'test-client', userId: 'test-user' };
    next();
  });
  app.use('/operator', operatorRouter);
  return app;
}

describe('[P3] GET /operator/:clientId/plan-mappings/:mappingId/holders — family scope', () => {
  let app;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('without accessId, returns the full mapping roster (Plan Mapping page occupancy view — unaffected)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'pm1' }] }) // mapping check
      .mockResolvedValueOnce({ rows: [] });              // roster
    const res = await request(app).get('/operator/c1/plan-mappings/pm1/holders');
    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(2); // no family-lookup query fired
    const mainSql = db.query.mock.calls[1][0];
    expect(mainSql).not.toMatch(/ma\.member_master_id = \$3/);
  });

  test('with accessId, looks up that access row\'s family key and scopes the roster to it', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'pm1' }] })                                       // mapping check
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-daxx', sub_master_id: null }] }) // family lookup — a holder
      .mockResolvedValueOnce({ rows: [] });                                                    // scoped roster
    const res = await request(app).get('/operator/c1/plan-mappings/pm1/holders').query({ accessId: 'access-daxx' });
    expect(res.status).toBe(200);
    const calls = db.query.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toEqual(['access-daxx', 'c1']); // family lookup scoped by clientId too
    const mainSql = calls[2][0];
    expect(mainSql).toMatch(/ma\.member_master_id = \$3 OR ma\.sub_master_id = \$3/);
    expect(calls[2][1]).toEqual(['pm1', 'c1', 'mm-daxx']); // holder's own member_master_id, not a stranger's
  });

  test('with accessId pointing at a sub-member, scopes by their holder\'s member_master_id, not their own', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'pm1' }] })
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-sub', sub_master_id: 'mm-holder' }] }) // a sub-member row
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/operator/c1/plan-mappings/pm1/holders').query({ accessId: 'access-sub' });
    expect(res.status).toBe(200);
    const calls = db.query.mock.calls;
    expect(calls[2][1]).toEqual(['pm1', 'c1', 'mm-holder']); // scoped to the holder, not the sub themselves
  });

  test('unrecognised accessId (no matching member_access row) falls back to the full roster, not an error', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'pm1' }] }) // mapping check
      .mockResolvedValueOnce({ rows: [] })               // family lookup — nothing found
      .mockResolvedValueOnce({ rows: [] });              // unscoped roster
    const res = await request(app).get('/operator/c1/plan-mappings/pm1/holders').query({ accessId: 'nonexistent' });
    expect(res.status).toBe(200);
    const calls = db.query.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2][0]).not.toMatch(/ma\.member_master_id = \$3/);
    expect(calls[2][1]).toEqual(['pm1', 'c1']); // no third param — filter never applied
  });
});
