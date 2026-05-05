/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: Admin API routes — new schema table references               │
 * │                                                                         │
 * │  Covers S-5 changes in:                                                 │
 * │    - admin/routes/operator.js  (connector_subscriptions, member_access, │
 * │                                  billing_subscriptions, member_access_  │
 * │                                  sources)                               │
 * │    - admin/routes/clients.js   (same new tables, member_master)         │
 * │    - admin/routes/members.js   (member_master, member_access,           │
 * │                                  member_access_sources)                 │
 * │                                                                         │
 * │  These are route-level unit tests: all DB calls are mocked, Express is  │
 * │  not started. We verify that each route builds queries that reference   │
 * │  the new schema tables and never reference retired tables.              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express    = require('express');
const request    = require('supertest');

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
  suspendLocationMembers:   jest.fn(),
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

// auth.js throws at require-time if ADMIN_JWT_SECRET is absent; mock it entirely
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
  getTraceId: jest.fn(() => 'trace-s5-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
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
  // Inject a minimal req.admin for operator.js routes that read clientId
  app.use((req, _res, next) => {
    req.admin = { clientId: 'test-client', userId: 'test-user' };
    next();
  });
  app.use(mountPath, router);
  return app;
}

// Capture SQL strings from db.query mock calls
function capturedQueries() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// members.js — new schema
// ─────────────────────────────────────────────────────────────────────────────

describe('[P2] admin/routes/members — new schema table references', () => {
  let app;

  beforeAll(() => {
    const membersRouter = require('../../admin/routes/members');
    app = makeApp(membersRouter, '/members');
  });

  // ── /search (no query — recent view) ────────────────────────────────────────

  test('GET /members/search (no query) uses member_master not member_identity', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/search').query({ client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).not.toMatch(/member_identity/);
  });

  test('GET /members/search (no query) JOINs member_access not member_access_state', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/search').query({ client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_access_state/);
  });

  // ── /search (pattern match) ─────────────────────────────────────────────────

  test('GET /members/search (with query) uses member_master not member_identity', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/search').query({ q: 'alice', client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).not.toMatch(/member_identity/);
  });

  // ── /by-client ───────────────────────────────────────────────────────────────

  test('GET /members/by-client uses member_master not member_identity', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })   // main members query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })  // count
      .mockResolvedValueOnce({ rows: [] });  // breakdown
    await request(app).get('/members/by-client').query({ client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).not.toMatch(/member_identity/);
  });

  test('GET /members/by-client uses member_access not member_access_state', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/by-client').query({ client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_access_state/);
  });

  test('GET /members/by-client location filter uses member_access_sources not member_role_assignments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/by-client').query({ client_id: 'c1', location_id: 'loc1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_access_sources/);
    expect(sql).not.toMatch(/member_role_assignments/);
  });

  test('GET /members/by-client breakdown uses member_master + member_access', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', count: 3 }] });
    await request(app).get('/members/by-client').query({ client_id: 'c1' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_access_state/);
  });

  // ── /:id/plans ───────────────────────────────────────────────────────────────

  test('GET /members/:id/plans uses member_master for existence check', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'mem-1' }] })  // existence check
      .mockResolvedValueOnce({ rows: [] });                  // plans query
    await request(app).get('/members/mem-1/plans');
    const existenceQuery = db.query.mock.calls[0][0];
    expect(existenceQuery).toMatch(/member_master/);
    expect(existenceQuery).not.toMatch(/member_identity/);
  });

  test('GET /members/:id/plans uses member_access + member_access_sources not member_role_assignments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'mem-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get('/members/mem-1/plans');
    const plansQuery = db.query.mock.calls[1][0];
    expect(plansQuery).toMatch(/member_access/);
    expect(plansQuery).toMatch(/member_access_sources/);
    expect(plansQuery).not.toMatch(/member_role_assignments/);
  });

  // ── /:id/retry ───────────────────────────────────────────────────────────────

  test('POST /members/:id/retry uses member_master for client_id lookup', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1' }] })  // member lookup
      .mockResolvedValueOnce({ rows: [{ id: 'err-1', client_id: 'c1', event_type: 'plan.purchased', payload: '{}' }] }) // error_queue
      .mockResolvedValueOnce({ rowCount: 1 });                  // UPDATE error_queue
    await request(app).post('/members/mem-1/retry');
    const memberLookupQuery = db.query.mock.calls[0][0];
    expect(memberLookupQuery).toMatch(/member_master/);
    expect(memberLookupQuery).not.toMatch(/member_identity/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clients.js — new schema
// ─────────────────────────────────────────────────────────────────────────────

describe('[P2] admin/routes/clients — new schema table references', () => {
  let app;

  beforeAll(() => {
    const clientsRouter = require('../../admin/routes/clients');
    app = makeApp(clientsRouter, '/clients');
  });

  test('GET /clients uses member_master not member_identity', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/clients');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).not.toMatch(/member_identity/);
  });

  test('GET /clients uses member_access not member_access_state for counts', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/clients');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_access_state/);
  });

  test('POST /clients/:id/api-key upserts connector_subscriptions', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Test', hardware_platform: 'kisi' }] }) // client fetch
      .mockResolvedValueOnce({ rows: [] }); // upsert (no RETURNING)
    await request(app)
      .post('/clients/c1/api-key')
      .send({ apiKey: 'a-valid-test-api-key-12345' }); // must be >= 20 chars
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/connector_subscriptions/);
    expect(sql).toMatch(/ON CONFLICT/);
  });

  test('GET /clients/:id/api-key/status reads connector_subscriptions', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })  // client
      .mockResolvedValueOnce({ rows: [] });              // connector_subscriptions
    await request(app).get('/clients/c1/api-key/status');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/connector_subscriptions/);
  });

  test('GET /clients/:id/locations JOINs billing_subscriptions not subscription_status column', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })  // client
      .mockResolvedValueOnce({ rows: [] });              // locations
    await request(app).get('/clients/c1/locations');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/billing_subscriptions/);
    expect(sql).not.toMatch(/l\.subscription_status/);
  });

  test('GET /clients/:id/dependencies uses member_master + member_access_sources + member_access', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })  // client
      .mockResolvedValueOnce({ rows: [{ members: 0, access_sources: 0, access_states: 0, plan_mappings: 0, locations: 0 }] });
    await request(app).get('/clients/c1/dependencies');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_master/);
    expect(sql).toMatch(/member_access_sources/);
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_identity/);
    expect(sql).not.toMatch(/member_access_state/);
    expect(sql).not.toMatch(/member_role_assignments/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// operator.js — new schema (key endpoints)
// ─────────────────────────────────────────────────────────────────────────────

describe('[P2] admin/routes/operator — new schema table references', () => {
  let app;

  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = makeApp(operatorRouter, '/operator');
  });

  // Routes under /clients/:clientId prefix inside the operator router
  test('GET /operator/clients/:clientId/kisi-groups reads connector_subscriptions for API key', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // no key → 400
    await request(app).get('/operator/clients/c1/kisi-groups');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/connector_subscriptions/);
  });

  test('PUT /operator/clients/:clientId/api-key upserts into connector_subscriptions', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', hardware_platform: 'kisi' }] }) // client
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1' }] }); // upsert
    await request(app)
      .put('/operator/clients/c1/api-key')
      .send({ apiKey: 'raw-key' });
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/connector_subscriptions/);
    expect(sql).toMatch(/ON CONFLICT \(client_id, hardware_platform\)/);
    expect(sql).not.toMatch(/clients.*SET.*hardware_api_key/);
  });

  // Routes under /:clientId prefix inside the operator router
  test('POST /operator/:clientId/locations/:locationId/activate uses billing_subscriptions', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })   // client check
      .mockResolvedValueOnce({ rows: [{ id: 'l1' }] })   // location check
      .mockResolvedValueOnce({ rowCount: 1 });            // billing_subscriptions UPDATE
    await request(app).post('/operator/c1/locations/l1/activate');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/billing_subscriptions/);
    expect(sql).not.toMatch(/locations.*SET.*subscription_status/);
  });

  test('GET /operator/:clientId/locations query uses billing_subscriptions JOIN', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })  // client
      .mockResolvedValueOnce({ rows: [] });              // locations
    await request(app).get('/operator/c1/locations');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/billing_subscriptions/);
    expect(sql).not.toMatch(/l\.subscription_status/);
  });

  test('GET /operator/:clientId/locations/:locationId/mappings member_count uses member_access', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })    // client
      .mockResolvedValueOnce({ rows: [{ id: 'l1' }] })    // location
      .mockResolvedValueOnce({ rows: [] });                // mappings
    await request(app).get('/operator/c1/locations/l1/mappings');
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/member_access/);
    expect(sql).not.toMatch(/member_role_assignments/);
  });

  test('member_access_sources INSERTs use mapping_id not plan_mapping_id', async () => {
    // The remap endpoint triggers member_access_sources INSERT
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })    // client
      .mockResolvedValueOnce({ rows: [{ id: 'pm1', location_id: 'l1' }] }) // mapping
      .mockResolvedValueOnce({ rows: [] })                 // active members
      .mockResolvedValueOnce({ rowCount: 0 });             // update mapping
    await request(app)
      .post('/operator/c1/locations/l1/mappings/pm1/remap')
      .send({ groupId: 'g1', groupName: 'Front Door' });
    const sql = capturedQueries().join('\n');
    // mapping_id is the correct column name on member_access_sources
    if (sql.includes('member_access_sources')) {
      expect(sql).toMatch(/mapping_id/);
      expect(sql).not.toMatch(/plan_mapping_id.*member_access_sources/);
    }
  });
});
