/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: OB-223 — server-side plan-name disambiguation on Members API │
 * │                                                                         │
 * │  When a client has two plan_mappings sharing the same plan_name (e.g.   │
 * │  two "Couples" plans on different doors), the operator UI must render   │
 * │  them with disambiguating suffixes — "Couples (…a1b2c3)" — so an        │
 * │  operator can tell them apart. This was shipped client-side for         │
 * │  Plan-Mapping + Dashboard via disambiguatePlanNames() in operator-      │
 * │  nav.js. Members page couldn't use it (load-order issue), so the fix    │
 * │  moved server-side: GET /:clientId/members emits a parallel             │
 * │  `plan_names_disambiguated[]` field on each member.                     │
 * │                                                                         │
 * │  Governed by: DR-025                                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Shared mocks ──────────────────────────────────────────────────────────────

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
  getTraceId:      jest.fn(() => 'trace-ob223'),
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

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] OB-223 — Members API emits plan_names_disambiguated', () => {
  let app;

  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');
  });

  test('GET /:clientId/members suffixes duplicate plan names with last-6 of source_plan_id', async () => {
    // Two plan_mappings share the name "Couples" — collision case.
    const mappingA = {
      id:             'pm-aaaaaaaa-0000-0000-0000-000000000001',
      plan_name:      'Couples',
      source_plan_id: 'src-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b2c3',
    };
    const mappingB = {
      id:             'pm-bbbbbbbb-0000-0000-0000-000000000002',
      plan_name:      'Couples',
      source_plan_id: 'src-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbd4e5f6',
    };
    // A third mapping with a unique name should pass through unchanged.
    const mappingSolo = {
      id:             'pm-cccccccc-0000-0000-0000-000000000003',
      plan_name:      'Solo',
      source_plan_id: 'src-cccccccccccccccccccccccccccccccc7g8h9i',
    };

    // Member holds BOTH "Couples" mappings → both entries must be suffixed.
    const memberRow = {
      id:                  'ma-1',
      platform_member_id:  'wix-member-1',
      hardware_platform:   'kisi',
      display_name:        'Test User',
      first_name:          'Test',
      last_name:           'User',
      email:               'test@example.com',
      access_status:       'active',
      provisioned_at:      new Date().toISOString(),
      plan_names:          ['Couples'],                             // DISTINCT collapses
      plan_ids:            [mappingA.source_plan_id, mappingB.source_plan_id],
      plan_valid_untils:   [null, null],
      plan_name:           'Couples',
      plan_billings:       null,
      billing_snapshot:    null,
      assignment_count:    2,
      active_source_count: 2,
      plan_mapping_id:     null,
      sub_plan_name:       null,
      role:                'holder',
      holder_id:           null,
      holder_name:         null,
      holder_email:        null,
      plan_holder_id:      null,
      plan_mapping_ids:    [mappingA.id, mappingB.id],              // NEW — non-collapsed
    };

    db.query
      .mockResolvedValueOnce({ rows: [memberRow] })                              // main members
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })                           // count
      .mockResolvedValueOnce({ rows: [mappingA, mappingB, mappingSolo] });        // plan_mappings

    const res = await request(app).get('/operator/c-hog/members');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members).toHaveLength(1);

    const m = res.body.members[0];
    expect(Array.isArray(m.plan_names_disambiguated)).toBe(true);
    expect(m.plan_names_disambiguated).toHaveLength(2);

    // Last 6 chars of source_plan_id, wrapped in " (…xxxxxx)" per DR-025 helper format.
    expect(m.plan_names_disambiguated).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Couples \(…[a-z0-9]{6}\)$/i),
      ])
    );
    // Both entries should be distinct (each pointing to its own mapping's source_plan_id tail).
    expect(new Set(m.plan_names_disambiguated).size).toBe(2);
    expect(m.plan_names_disambiguated).toContain('Couples (…a1b2c3)');
    expect(m.plan_names_disambiguated).toContain('Couples (…d4e5f6)');

    // Additive — never mutate plan_names.
    expect(m.plan_names).toEqual(['Couples']);
  });

  test('non-colliding plan_name passes through without suffix', async () => {
    const soloMapping = {
      id:             'pm-solo-1',
      plan_name:      'Solo',
      source_plan_id: 'src-solo-xxxxxxxxxx',
    };
    const memberRow = {
      id:                  'ma-2',
      platform_member_id:  'wix-2',
      hardware_platform:   'kisi',
      display_name:        'Solo User',
      email:                'solo@example.com',
      access_status:       'active',
      provisioned_at:      new Date().toISOString(),
      plan_names:          ['Solo'],
      plan_ids:            [soloMapping.source_plan_id],
      plan_valid_untils:   [null],
      plan_name:           'Solo',
      plan_billings:       null,
      billing_snapshot:    null,
      assignment_count:    1,
      active_source_count: 1,
      plan_mapping_id:     soloMapping.id,
      sub_plan_name:       null,
      role:                'holder',
      plan_mapping_ids:    [soloMapping.id],
    };

    db.query
      .mockResolvedValueOnce({ rows: [memberRow] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [soloMapping] });

    const res = await request(app).get('/operator/c-hog/members');
    expect(res.status).toBe(200);
    const m = res.body.members[0];
    expect(m.plan_names_disambiguated).toEqual(['Solo']); // no suffix
  });

  test('SQL fetches client plan_mappings for collision detection', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get('/operator/c-hog/members');
    const sqls = db.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
    // The 3rd query should be the plan_mappings fetch for disambiguation.
    expect(sqls.some((s) => /FROM\s+plan_mappings/i.test(s) && /client_id\s*=\s*\$1/i.test(s))).toBe(true);
  });
});
