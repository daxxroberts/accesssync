/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: GET /operator/:clientId sync metrics are churn-proof         │
 * │                                                                         │
 * │  Regression origin (Builder report, House of Gains, 2026-09-08):        │
 * │  the dashboard read "7 pending" on an account that was perfectly in     │
 * │  sync — 5 active Wix members, 5 Kisi members, 0 errors. The Synced/     │
 * │  Total tile was rendering active_members / total_members and labelling  │
 * │  the difference "pending". total_members is COUNT(*) FROM member_master │
 * │  — the LIFETIME onboarded count — so all 7 cancelled/test members were  │
 * │  reported as stuck provisioning.                                        │
 * │                                                                         │
 * │  These tests pin the replacement metrics:                               │
 * │    synced_members  — distinct people fully live in hardware             │
 * │    managed_members — distinct people AccessSync is responsible for      │
 * │    pending_members — derived, never negative, never churn               │
 * │    unmanaged_count — hardware users with no DB source row               │
 * │                                                                         │
 * │  Route-level unit tests: all DB calls mocked, Express not started.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

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
  getTraceId:      jest.fn(() => 'trace-sync-metrics-test'),
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
    req.admin = { clientId: 'test-client', userId: 'test-user' };
    next();
  });
  app.use(mountPath, router);
  return app;
}

function capturedQueries() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}

/**
 * GET /operator/:clientId fires its counts through one Promise.all. The mocks
 * resolve in construction order, which is the array order in the route.
 */
function mockOverview({ active, total, pendingHardware, synced, managed, unmanaged }) {
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'House of Gains', platform: 'wix', last_sync_at: null, last_webhook_at: null }] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })                // errorCount
    .mockResolvedValueOnce({ rows: [{ count: active }] })           // activeMembers
    .mockResolvedValueOnce({ rows: [{ count: total }] })            // totalMembers
    .mockResolvedValueOnce({ rows: [{ count: 1 }] })                // locationCount
    .mockResolvedValueOnce({ rows: [{ count: pendingHardware }] })  // pendingHardware
    .mockResolvedValueOnce({ rows: [{ count: synced }] })           // syncedMembers
    .mockResolvedValueOnce({ rows: [{ count: managed }] })          // managedMembers
    .mockResolvedValueOnce({ rows: [{ count: unmanaged }] })        // unmanagedCount
    .mockResolvedValueOnce({ rows: [] })                            // connector
    .mockResolvedValueOnce({ rows: [{ tier: 'Connect' }] });        // billing tier
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('[P3] GET /operator/:clientId — sync metrics survive churn', () => {
  let app;

  beforeAll(() => {
    app = makeApp(require('../../admin/routes/operator'), '/operator');
  });

  test('the House of Gains case: 5 active, 12 lifetime, fully synced → 0 pending', async () => {
    // The exact shape that produced the "7 pending" false alarm.
    mockOverview({ active: 5, total: 12, pendingHardware: 0, synced: 5, managed: 5, unmanaged: 0 });
    const res = await request(app).get('/operator/c1');

    expect(res.status).toBe(200);
    expect(res.body.stats.pending_members).toBe(0);
    expect(res.body.stats.synced_members).toBe(5);
    expect(res.body.stats.managed_members).toBe(5);
    // The churn gap must never leak into the pending figure.
    expect(res.body.stats.pending_members).not.toBe(res.body.stats.total_members - res.body.stats.active_members);
  });

  test('genuine provisioning gap is reported as pending', async () => {
    // 6 people managed, only 4 live in hardware → 2 actually stuck.
    mockOverview({ active: 6, total: 20, pendingHardware: 2, synced: 4, managed: 6, unmanaged: 0 });
    const res = await request(app).get('/operator/c1');

    expect(res.body.stats.pending_members).toBe(2);
  });

  test('pending_members is clamped at zero if synced ever exceeds managed', async () => {
    mockOverview({ active: 5, total: 5, pendingHardware: 0, synced: 5, managed: 3, unmanaged: 0 });
    const res = await request(app).get('/operator/c1');

    expect(res.body.stats.pending_members).toBe(0);
  });

  test('total_members is still returned — reporting needs it, the tile does not', async () => {
    mockOverview({ active: 5, total: 12, pendingHardware: 0, synced: 5, managed: 5, unmanaged: 0 });
    const res = await request(app).get('/operator/c1');

    expect(res.body.stats.total_members).toBe(12);
    expect(res.body.stats.active_members).toBe(5);
  });

  test('unmanaged_count is surfaced for hardware users AccessSync does not own', async () => {
    mockOverview({ active: 5, total: 12, pendingHardware: 0, synced: 5, managed: 5, unmanaged: 2 });
    const res = await request(app).get('/operator/c1');

    expect(res.body.stats.unmanaged_count).toBe(2);
  });
});

describe('[P3] GET /operator/:clientId — sync metric queries are person-scoped', () => {
  let app;

  beforeAll(() => {
    app = makeApp(require('../../admin/routes/operator'), '/operator');
  });

  beforeEach(async () => {
    mockOverview({ active: 5, total: 12, pendingHardware: 0, synced: 5, managed: 5, unmanaged: 0 });
    await request(app).get('/operator/c1');
  });

  test('managed_members excludes terminal and former-member states', () => {
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/status IN \('active', 'in_flight', 'pending_identity', 'recovery_pending'\)/);
    // Churned states must never enter the sync denominator.
    expect(sql).not.toMatch(/status IN \([^)]*'inactive'/);
    expect(sql).not.toMatch(/status IN \([^)]*'deleted'/);
  });

  test('synced_members counts distinct people, not access rows', () => {
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/COUNT\(DISTINCT ma\.member_master_id\)[\s\S]*?NOT EXISTS/);
  });

  test('synced_members treats every incomplete source state as not-synced', () => {
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/mas\.status IN \('pending_hardware', 'pending_start', 'failed'\)/);
  });

  test('unmanaged_count is scoped to the newest reconciliation run, not all history', () => {
    const sql = capturedQueries().join('\n');
    expect(sql).toMatch(/reconciliation_run/);
    expect(sql).toMatch(/ORDER BY started_at DESC/);
    expect(sql).toMatch(/RECONCILIATION_UNMANAGED_ASSIGNMENT_OBSERVED/);
  });
});
