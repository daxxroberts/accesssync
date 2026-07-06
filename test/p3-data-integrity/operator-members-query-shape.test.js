/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: GET /:clientId/members — query-shape characterization        │
 * │                                                                         │
 * │  The Members API SELECT is the widest query in the codebase (8 scalar   │
 * │  subqueries + a LATERAL latency join + holder-fallback aggregation).    │
 * │  This suite pins its STRUCTURE so the 2026-07-06 fragment-builder       │
 * │  restructure (and any future edit) cannot silently drop a column,       │
 * │  a dead-status filter, or the holder-fallback branch.                   │
 * │                                                                         │
 * │  Counting assertions are exact on purpose: if you add or remove a       │
 * │  subquery, update the count here consciously.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Shared mocks (same scaffold as operator-members-disambiguation.test.js) ──

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
  getTimeline:    jest.fn(),
}));

jest.mock('../../core/reconciliation', () => ({
  reconcileMember: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers:    jest.fn(),
  reactivateLocationMembers: jest.fn(),
}));

jest.mock('../../admin/middleware/audit', () => ({
  logAdminAction: jest.fn(),
}));

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  getGroups: jest.fn(),
  getLocks:  jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks:        jest.fn(),
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
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
  getTraceId:      jest.fn(() => 'trace-shape'),
  getActor:        jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
}));

jest.mock('../../admin/middleware/activity', () => ({
  recordActivity: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const db = require('../../db');

function makeApp(router, mountPath = '/') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { clientId: 'c-hog', userId: 'u-test' };
    next();
  });
  app.use(mountPath, router);
  return app;
}

function mockMembersQueries(memberRows = []) {
  db.query
    .mockResolvedValueOnce({ rows: memberRows })                    // main members
    .mockResolvedValueOnce({ rows: [{ total: memberRows.length }] }) // count
    .mockResolvedValueOnce({ rows: [] });                            // plan_mappings
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] Members API — main SELECT structure', () => {
  let app;
  let mainSql, mainParams, countSql, countParams, mappingsSql, mappingsParams;

  beforeAll(async () => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');

    mockMembersQueries();
    const res = await request(app).get('/operator/c-hog/members');
    expect(res.status).toBe(200);

    [mainSql, mainParams]         = db.query.mock.calls[0];
    [countSql, countParams]       = db.query.mock.calls[1];
    [mappingsSql, mappingsParams] = db.query.mock.calls[2];
  });

  test('every output column alias the bridge/UI reads is present', () => {
    const aliases = [
      'plan_names', 'plan_ids', 'plan_mapping_ids', 'plan_valid_untils',
      'plan_name', 'plan_billings', 'billing_snapshot',
      'assignment_count', 'active_source_count',
      'plan_holder_id', 'plan_mapping_id', 'sub_plan_name',
      'access_status', 'role', 'holder_id', 'holder_name', 'holder_email',
      'webhook_received_at', 'enqueued_at', 'kisi_confirmed_at',
      'ingest_s', 'processing_s', 'total_s',
    ];
    for (const alias of aliases) {
      expect(mainSql).toMatch(new RegExp(`AS ${alias}\\b|AS\\s+${alias}\\b|${alias},|${alias}\\s`));
      expect(mainSql).toContain(alias);
    }
  });

  test('holder-fallback branch exists for exactly the 4 COALESCE\'d plan fields', () => {
    // plan_names, plan_ids, plan_mapping_ids, plan_name each fall back to
    // aggregating the holder's sub-members' source rows.
    expect(countOccurrences(mainSql, 'sub_ma.sub_master_id = ma.member_master_id')).toBe(4);
  });

  test('dead source rows are filtered from every plan/billing subquery (exact count)', () => {
    // 13 = own+sub for plan_names/plan_ids/plan_mapping_ids/plan_name (8),
    //      plan_valid_untils (1), billing_snapshot (1), assignment_count (1),
    //      plan_mapping_id (1), sub_plan_name (1).
    expect(countOccurrences(mainSql, `NOT IN ('cancelled','revoked')`)).toBe(13);
  });

  test('the three aggregate arrays keep their DISTINCT + ORDER BY shape (own + fallback)', () => {
    expect(countOccurrences(mainSql, 'ARRAY_AGG(DISTINCT pm.plan_name ORDER BY pm.plan_name)')).toBe(2);
    expect(countOccurrences(mainSql, 'ARRAY_AGG(DISTINCT pm.source_plan_id ORDER BY pm.source_plan_id)')).toBe(2);
    expect(countOccurrences(mainSql, 'ARRAY_AGG(DISTINCT pm.id ORDER BY pm.id)')).toBe(2);
  });

  test('plan_billings reads v_active_members and carries all 11 JSONB keys', () => {
    expect(mainSql).toContain('FROM v_active_members vam');
    for (const key of [
      'planName', 'planPrice', 'cycleUnit', 'monthlyRate', 'currency',
      'couponCode', 'couponAmount', 'autoRenew', 'lastPaymentStatus',
      'beginDate', 'endDate',
    ]) {
      expect(mainSql).toContain(`'${key}'`);
    }
  });

  test('latency LATERAL join keeps its accepted/new webhook gates', () => {
    expect(mainSql).toContain('LEFT JOIN LATERAL');
    expect(mainSql).toContain(`wl.hmac_status = 'accepted'`);
    expect(mainSql).toContain(`wl.dedup_status = 'new'`);
    expect(mainSql).toContain('mas_lat.created_at > wl.received_at');
  });

  test('DR-044: soft-deleted and removing sub-members are excluded', () => {
    expect(mainSql).toContain(`ma.status NOT IN ('deleted', 'removing')`);
    expect(countSql).toContain(`ma.status NOT IN ('deleted', 'removing')`);
  });

  test('pagination: LIMIT/OFFSET are the last two params; default page → [clientId, 25, 0]', () => {
    expect(mainSql).toMatch(/ORDER {2}BY ma\.provisioned_at DESC NULLS LAST/);
    expect(mainParams).toEqual(['c-hog', 25, 0]);
    expect(countParams).toEqual(['c-hog']);
  });

  test('plan_mappings disambiguation query is client-scoped', () => {
    expect(mappingsSql).toContain('FROM   plan_mappings');
    expect(mappingsParams).toEqual(['c-hog']);
  });
});

describe('[P3] Members API — dynamic filters', () => {
  let app;

  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');
  });

  test('status + location_id + paging compose conditions and params in order', async () => {
    mockMembersQueries();
    const res = await request(app)
      .get('/operator/c-hog/members?status=active&location_id=loc-1&page=2&limit=10');
    expect(res.status).toBe(200);

    const [mainSql, mainParams]  = db.query.mock.calls[0];
    const [, countParams]        = db.query.mock.calls[1];

    expect(mainSql).toContain('ma.status = $2');
    expect(mainSql).toMatch(/EXISTS \(\s*SELECT 1 FROM member_access_sources mas2\s*JOIN plan_mappings pm ON pm\.id = mas2\.mapping_id AND pm\.location_id = \$3/);
    expect(mainParams).toEqual(['c-hog', 'active', 'loc-1', 10, 10]); // page 2, limit 10 → offset 10
    expect(countParams).toEqual(['c-hog', 'active', 'loc-1']);
  });
});

describe('[P3] Members API — effective_status derivation (response shaping)', () => {
  let app;

  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');
  });

  const baseRow = {
    id: 'ma-1', platform_member_id: 'wix-1', hardware_platform: 'kisi',
    display_name: 'T U', first_name: 'T', last_name: 'U', email: 't@u.v',
    provisioned_at: null, plan_names: null, plan_ids: null, plan_mapping_ids: null,
    plan_valid_untils: null, plan_name: null, plan_billings: null,
    billing_snapshot: null, plan_holder_id: null, plan_mapping_id: null,
    sub_plan_name: null, holder_id: null, holder_name: null, holder_email: null,
  };

  test("inactive with sources but none active → 'partial'", async () => {
    mockMembersQueries([{ ...baseRow, access_status: 'inactive', assignment_count: 2, active_source_count: 0, role: 'sub' }]);
    const res = await request(app).get('/operator/c-hog/members');
    expect(res.body.members[0].effective_status).toBe('partial');
  });

  test("active holder with no own active sources → 'holder_only'", async () => {
    mockMembersQueries([{ ...baseRow, access_status: 'active', assignment_count: 0, active_source_count: 0, role: 'holder' }]);
    const res = await request(app).get('/operator/c-hog/members');
    expect(res.body.members[0].effective_status).toBe('holder_only');
  });

  test('recovery_pending passes through untouched (OB-202)', async () => {
    mockMembersQueries([{ ...baseRow, access_status: 'recovery_pending', assignment_count: 1, active_source_count: 0, role: 'sub' }]);
    const res = await request(app).get('/operator/c-hog/members');
    expect(res.body.members[0].effective_status).toBe('recovery_pending');
  });

  test('plain active member passes through untouched', async () => {
    mockMembersQueries([{ ...baseRow, access_status: 'active', assignment_count: 1, active_source_count: 1, role: 'sub' }]);
    const res = await request(app).get('/operator/c-hog/members');
    expect(res.body.members[0].effective_status).toBe('active');
  });
});
