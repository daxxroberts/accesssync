/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: multi-member routes — new schema table references + OB-150  │
 * │                                                                         │
 * │  Covers S-7 changes in admin/routes/multi-member.js:                   │
 * │    - All 7 routes migrated from member_identity / member_access_state / │
 * │      member_role_assignments to member_master / member_access /         │
 * │      member_access_sources                                              │
 * │                                                                         │
 * │  OB-150 carry-forward test is mandatory — this suite is NOT complete    │
 * │  without it. The DELETE route must populate syntheticEvent.planId from  │
 * │  the plan_mappings JOIN or hardware revokes are silently suppressed.    │
 * │                                                                         │
 * │  DR-040: sub-member quota is per plan_mapping_id, not pooled.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({ query: jest.fn() }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eventQueue.add is the critical call we assert planId on for OB-150
const mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: mockQueueAdd },
}));

jest.mock('../../core/trace-context', () => ({
  mintTraceId: jest.fn(() => 'trace-mm-test'),
  getTraceId:  jest.fn(() => 'trace-mm-test'),
  getActor:    jest.fn(() => ({ type: 'test', id: 'test' })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const db = require('../../db');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin    = { clientId: 'c1', email: 'admin@test.com', actorType: 'admin' };
    req.operator = { clientId: 'c1', actorType: 'operator' };
    next();
  });
  // multi-member.js mounts routes at top level — mount at /
  const router = require('../../admin/routes/multi-member');
  app.use('/', router);
  return app;
}

function capturedQueries() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: return a resolved promise for any unregistered db.query call.
  // This covers the fire-and-forget recordSyntheticOrigin() calls (trace_context +
  // activity_event INSERTs) that fire via setImmediate after the response is sent.
  // Per-test mockResolvedValueOnce calls take priority in sequence order.
  db.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /member/:memberId/widget-data — new schema
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — GET /member/:memberId/widget-data', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('holder lookup uses member_master JOIN member_access not member_identity', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', access_id: 'a1', platform_member_id: 'p1', first_name: 'Joe', last_name: 'Smith', email: 'j@test.com', phone: '555', access_status: 'active', provisioned_at: null }] })
      .mockResolvedValueOnce({ rows: [] }) // plans
      .mockResolvedValueOnce({ rows: [] }) // sub-members
      .mockResolvedValueOnce({ rows: [] }); // holder slot check

    await request(app).get('/member/mm1/widget-data').query({ clientId: 'c1' });

    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_identity/);
    expect(sql).not.toMatch(/member_access_state/);
  });

  test('sub-members fetched via member_access WHERE sub_master_id not plan_holder_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', access_id: 'a1', platform_member_id: 'p1', first_name: 'Joe', last_name: 'Smith', email: 'j@test.com', phone: '555', access_status: 'active', provisioned_at: null }] })
      .mockResolvedValueOnce({ rows: [] }) // plans
      .mockResolvedValueOnce({ rows: [] }) // sub-members
      .mockResolvedValueOnce({ rows: [] }); // holder slot check

    await request(app).get('/member/mm1/widget-data').query({ clientId: 'c1' });

    const subMemberQuery = db.query.mock.calls[2]?.[0] || '';
    expect(subMemberQuery).toMatch(/sub_master_id/);
    expect(subMemberQuery).not.toMatch(/plan_holder_id/);
    expect(subMemberQuery).not.toMatch(/member_identity/);
  });

  test('holder slot check uses member_access not member_role_assignments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', access_id: 'a1', platform_member_id: 'p1', first_name: 'Joe', last_name: 'Smith', email: 'j@test.com', phone: '555', access_status: 'active', provisioned_at: null }] })
      .mockResolvedValueOnce({ rows: [] }) // plans
      .mockResolvedValueOnce({ rows: [] }) // sub-members
      .mockResolvedValueOnce({ rows: [] }); // holder slot check

    await request(app).get('/member/mm1/widget-data').query({ clientId: 'c1' });

    const slotQuery = db.query.mock.calls[3]?.[0] || '';
    expect(slotQuery).toMatch(/member_access/);
    expect(slotQuery).not.toMatch(/member_role_assignments/);
  });

  test('returns 404 when holder not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/member/missing/widget-data').query({ clientId: 'c1' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/multi-member/members — two-table INSERT
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — POST /api/multi-member/members', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('INSERT splits into member_master + member_access rows', async () => {
    db.query
      // holder check
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', hardware_platform: 'kisi', platform_member_id: 'holder-pid', source_platform: 'wix' }] })
      // plan check
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', max_members: 3 }] })
      // slot count
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      // holder platform_member_id lookup is already in holderCheck above
      // INSERT member_master
      .mockResolvedValueOnce({ rows: [{ id: 'mm-new', platform_member_id: 'holder-pid###asabc123', first_name: 'Jane', last_name: 'Doe', email: 'jane@test.com', phone: '555' }] })
      // INSERT member_access
      .mockResolvedValueOnce({ rows: [{ id: 'acc-new', status: 'pending', plan_mapping_id: 'pm1' }] });

    const res = await request(app)
      .post('/api/multi-member/members')
      .send({ holderId: 'mm1', clientId: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', phone: '555-1234', planMappingId: 'pm1' });

    expect(res.status).toBe(201);

    const allSql = capturedQueries().join('\n');
    // Both INSERT targets must be in the new schema
    expect(allSql).toMatch(/INSERT INTO member_master/);
    expect(allSql).toMatch(/INSERT INTO member_access/);
    expect(allSql).not.toMatch(/INSERT INTO member_identity/);
  });

  test('slot count query uses member_access not member_identity', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', hardware_platform: 'kisi', platform_member_id: 'holder-pid', source_platform: 'wix' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', max_members: 2 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // one slot taken
      .mockResolvedValueOnce({ rows: [{ id: 'mm-new', platform_member_id: 'p2', first_name: 'X', last_name: 'Y', email: 'x@test.com', phone: '555' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a2', status: 'pending', plan_mapping_id: 'pm1' }] });

    await request(app)
      .post('/api/multi-member/members')
      .send({ holderId: 'mm1', clientId: 'c1', firstName: 'X', lastName: 'Y', email: 'x@test.com', phone: '555', planMappingId: 'pm1' });

    const slotSql = db.query.mock.calls[2]?.[0] || '';
    expect(slotSql).toMatch(/member_access/);
    expect(slotSql).toMatch(/sub_master_id/);
    expect(slotSql).not.toMatch(/member_identity/);
    expect(slotSql).not.toMatch(/plan_holder_id/);
  });

  test('DR-040: slot count is scoped to plan_mapping_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', hardware_platform: 'kisi', platform_member_id: 'holder-pid', source_platform: 'wix' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', max_members: 2 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'mm-new', platform_member_id: 'p3', first_name: 'A', last_name: 'B', email: 'a@test.com', phone: '555' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a3', status: 'pending', plan_mapping_id: 'pm1' }] });

    await request(app)
      .post('/api/multi-member/members')
      .send({ holderId: 'mm1', clientId: 'c1', firstName: 'A', lastName: 'B', email: 'a@test.com', phone: '555', planMappingId: 'pm1' });

    const slotSql = db.query.mock.calls[2]?.[0] || '';
    expect(slotSql).toMatch(/plan_mapping_id/);
  });

  test('returns 409 when plan is full', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', hardware_platform: 'kisi', platform_member_id: 'hp', source_platform: 'wix' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', max_members: 1 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }); // full

    const res = await request(app)
      .post('/api/multi-member/members')
      .send({ holderId: 'mm1', clientId: 'c1', firstName: 'Z', lastName: 'Z', email: 'z@test.com', phone: '555', planMappingId: 'pm1' });

    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/multi-member/members/:subId — OB-150 LOAD-BEARING
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — DELETE /api/multi-member/members/:subId (OB-150)', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  // OB-150 MANDATORY TEST — sprint is NOT complete without this passing
  test('OB-150: syntheticEvent.planId is populated from plan_mappings JOIN (non-null)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id:               'acc-sub',
        status:           'active',
        hardware_user_id: 'kisi-user-99',
        client_id:        'c1',
        plan_mapping_id:  'pm1',
        member_master_id: 'mm-sub',
        sub_master_id:    'mm-holder',
        platform_member_id: 'holder###as001',
        source_plan_id:   'plan-xyz',   // <-- load-bearing field from pm.source_plan_id JOIN
      }]
    });
    // UPDATE status='removing'
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/multi-member/members/acc-sub');

    expect(res.status).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const [jobType, jobPayload] = mockQueueAdd.mock.calls[0];
    expect(jobType).toBe('revoke');
    // The load-bearing assertion: planId must be 'plan-xyz', not null
    expect(jobPayload.standardEvent.planId).toBe('plan-xyz');
    expect(jobPayload.standardEvent.planId).not.toBeNull();
  });

  test('OB-150: query JOINs plan_mappings to get source_plan_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'active', hardware_user_id: 'ku1', client_id: 'c1', plan_mapping_id: 'pm1', member_master_id: 'mm1', sub_master_id: 'mh1', platform_member_id: 'p1', source_plan_id: 'pid-1' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app).delete('/api/multi-member/members/a1');

    const memberLookupSql = db.query.mock.calls[0][0];
    expect(memberLookupSql).toMatch(/plan_mappings/);
    expect(memberLookupSql).toMatch(/source_plan_id/);
    expect(memberLookupSql).not.toMatch(/member_identity/);
    expect(memberLookupSql).not.toMatch(/member_access_state/);
  });

  test('pending sub-member: hard deletes member_access and member_master', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'pending', hardware_user_id: null, client_id: 'c1', plan_mapping_id: 'pm1', member_master_id: 'mm1', sub_master_id: 'mh1', platform_member_id: 'p1', source_plan_id: 'pid' }] })
      .mockResolvedValueOnce({ rows: [] }) // DELETE member_access
      .mockResolvedValueOnce({ rows: [] }); // DELETE member_master if orphan

    const res = await request(app).delete('/api/multi-member/members/a1');

    expect(res.status).toBe(200);
    const deleteSqls = capturedQueries().filter(q => /DELETE/i.test(q));
    expect(deleteSqls.some(q => /member_access/.test(q))).toBe(true);
    expect(deleteSqls.some(q => /member_master/.test(q))).toBe(true);
    expect(deleteSqls.every(q => !/member_identity/.test(q))).toBe(true);
  });

  test('active sub-member without hardware: hard deletes immediately', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'active', hardware_user_id: null, client_id: 'c1', plan_mapping_id: 'pm1', member_master_id: 'mm1', sub_master_id: 'mh1', platform_member_id: 'p1', source_plan_id: 'pid' }] })
      .mockResolvedValueOnce({ rows: [] }) // DELETE member_access
      .mockResolvedValueOnce({ rows: [] }); // DELETE member_master

    const res = await request(app).delete('/api/multi-member/members/a1');

    expect(res.status).toBe(200);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('terminal state: returns 410 when status is deleted', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'deleted', hardware_user_id: null, client_id: 'c1', plan_mapping_id: 'pm1', member_master_id: 'mm1', sub_master_id: 'mh1', platform_member_id: 'p1', source_plan_id: null }] });

    const res = await request(app).delete('/api/multi-member/members/a1');

    expect(res.status).toBe(410);
  });

  test('returns 404 when sub-member not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/multi-member/members/missing');

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/multi-member/submit — status transition + BullMQ
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — POST /api/multi-member/submit', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('fetches drafts from member_access not member_identity', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', platform_member_id: 'p1', plan_mapping_id: 'pm1', first_name: 'A', last_name: 'B', email: 'a@x.com', phone: '1', source_plan_id: 'sp1' }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE status
      ;

    await request(app).post('/api/multi-member/submit').send({ holderId: 'hh1', clientId: 'c1' });

    const fetchSql = db.query.mock.calls[0][0];
    expect(fetchSql).toMatch(/member_access/);
    expect(fetchSql).toMatch(/sub_master_id/);
    expect(fetchSql).not.toMatch(/member_identity/);
    expect(fetchSql).not.toMatch(/plan_holder_id/);
  });

  test('UPDATE sets status to pending_hardware not submitted, member_access_state is NOT written', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ access_id: 'a1', platform_member_id: 'p1', plan_mapping_id: 'pm1', first_name: 'A', last_name: 'B', email: 'a@x.com', phone: '1', source_plan_id: 'sp1' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    await request(app).post('/api/multi-member/submit').send({ holderId: 'hh1', clientId: 'c1' });

    const allSql = capturedQueries().join('\n');
    expect(allSql).toMatch(/pending_hardware/);
    expect(allSql).not.toMatch(/member_access_state/);
    expect(allSql).not.toMatch(/pending_sync/);
  });

  test('enqueues one BullMQ grant job per draft with correct planId', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { access_id: 'a1', platform_member_id: 'p1', plan_mapping_id: 'pm1', first_name: 'A', last_name: 'B', email: 'a@x.com', phone: '1', source_plan_id: 'plan-aaa' },
        { access_id: 'a2', platform_member_id: 'p2', plan_mapping_id: 'pm2', first_name: 'C', last_name: 'D', email: 'c@x.com', phone: '2', source_plan_id: 'plan-bbb' },
      ]})
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    await request(app).post('/api/multi-member/submit').send({ holderId: 'hh1', clientId: 'c1' });

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    const [, job1] = mockQueueAdd.mock.calls[0];
    const [, job2] = mockQueueAdd.mock.calls[1];
    expect(job1.standardEvent.planId).toBe('plan-aaa');
    expect(job2.standardEvent.planId).toBe('plan-bbb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/multi-member/holder-claim-slot — slot count from member_access
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — POST /api/multi-member/holder-claim-slot', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('slot count uses member_access not member_role_assignments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'p1', first_name: 'H', last_name: 'H', email: 'h@x.com' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', source_plan_id: 'sp1', max_members: 3 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // holder slot check
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }); // sub count

    await request(app).post('/api/multi-member/holder-claim-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });

    const allSql = capturedQueries().join('\n');
    expect(allSql).not.toMatch(/member_role_assignments/);
    const slotCountSqls = capturedQueries().filter(q => /member_access/.test(q) && /COUNT/.test(q));
    expect(slotCountSqls.length).toBeGreaterThan(0);
  });

  test('DR-040: holder slot check is scoped to plan_mapping_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'p1', first_name: 'H', last_name: 'H', email: 'h@x.com' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', source_plan_id: 'sp1', max_members: 3 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    await request(app).post('/api/multi-member/holder-claim-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });

    const holderSlotSql = db.query.mock.calls[2]?.[0] || '';
    expect(holderSlotSql).toMatch(/plan_mapping_id/);
  });

  test('returns 409 when holder already has slot', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'p1', first_name: 'H', last_name: 'H', email: 'h@x.com' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', source_plan_id: 'sp1', max_members: 3 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }); // already has slot

    const res = await request(app).post('/api/multi-member/holder-claim-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });
    expect(res.status).toBe(409);
  });

  test('enqueues grant job with correct planId', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'holder-pid', first_name: 'H', last_name: 'H', email: 'h@x.com' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', source_plan_id: 'plan-claim-xyz', max_members: 3 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    await request(app).post('/api/multi-member/holder-claim-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, payload] = mockQueueAdd.mock.calls[0];
    expect(payload.standardEvent.planId).toBe('plan-claim-xyz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/multi-member/holder-release-slot — member_access_sources check
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — POST /api/multi-member/holder-release-slot', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('assignment check uses member_access_sources not member_role_assignments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [{ role_assignment_id: 'ra1' }] }); // member_access_sources

    await request(app).post('/api/multi-member/holder-release-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });

    const assignmentSql = db.query.mock.calls[1]?.[0] || '';
    expect(assignmentSql).toMatch(/member_access_sources/);
    expect(assignmentSql).not.toMatch(/member_role_assignments/);
  });

  test('returns 409 when holder is not on the plan', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [] }); // no assignment

    const res = await request(app).post('/api/multi-member/holder-release-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });
    expect(res.status).toBe(409);
  });

  test('enqueues revoke job when holder releases slot', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm1', platform_member_id: 'release-pid' }] })
      .mockResolvedValueOnce({ rows: [{ role_assignment_id: 'ra1' }] });

    await request(app).post('/api/multi-member/holder-release-slot').send({ holderId: 'mm1', clientId: 'c1', planMappingId: 'pm1' });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [jobType, payload] = mockQueueAdd.mock.calls[0];
    expect(jobType).toBe('revoke');
    expect(payload.standardEvent.mappingId).toBe('pm1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/multi-member/members/:subId — UPDATE member_master not member_identity
// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] multi-member — PUT /api/multi-member/members/:subId', () => {
  let app;
  beforeAll(() => { app = makeApp(); });

  test('updates member_master not member_identity', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-sub' }] }) // access status check
      .mockResolvedValueOnce({ rows: [{ id: 'mm-sub', first_name: 'New', last_name: 'Name', email: 'new@x.com', phone: '999' }] }); // UPDATE member_master

    const res = await request(app)
      .put('/api/multi-member/members/acc-sub')
      .send({ firstName: 'New', lastName: 'Name', email: 'new@x.com', phone: '999' });

    expect(res.status).toBe(200);
    const updateSql = db.query.mock.calls[1]?.[0] || '';
    expect(updateSql).toMatch(/UPDATE member_master/);
    expect(updateSql).not.toMatch(/UPDATE member_identity/);
  });

  test('access check validates sub_master_id IS NOT NULL and pending status', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-sub' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'mm-sub', first_name: 'A', last_name: 'B', email: 'a@x.com', phone: '1' }] });

    await request(app)
      .put('/api/multi-member/members/acc-sub')
      .send({ firstName: 'A', lastName: 'B', email: 'a@x.com', phone: '1' });

    const accessCheckSql = db.query.mock.calls[0]?.[0] || '';
    expect(accessCheckSql).toMatch(/sub_master_id/);
    expect(accessCheckSql).not.toMatch(/plan_holder_id/);
    expect(accessCheckSql).not.toMatch(/member_identity/);
  });

  test('returns 404 when sub-member not in pending state', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no pending row found

    const res = await request(app)
      .put('/api/multi-member/members/acc-active')
      .send({ firstName: 'X', lastName: 'Y', email: 'x@test.com', phone: '1' });

    expect(res.status).toBe(404);
  });
});
