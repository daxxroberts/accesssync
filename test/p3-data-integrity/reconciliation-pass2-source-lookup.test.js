/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: OB-225 — Pass 2 source-lookup matches across JS-int vs       │
 * │            DB-varchar boundary                                          │
 * │                                                                         │
 * │  Bug class: Kisi adapter returns userId/groupId as JS numbers (e.g.     │
 * │  100560021, 838622). DB columns member_access.hardware_user_id and     │
 * │  member_access_sources.hardware_group_id are character varying.        │
 * │  Passing a JS Number through a node-pg parameterized query lets the    │
 * │  driver infer an int OID, and Postgres then refuses varchar = int4     │
 * │  (SQLSTATE 42883). Live signal: 6× false `unmanaged_assignment_observed│
 * │  / no_matching_db_source_row` emissions in 7 days for Drew (Kisi user  │
 * │  100560021), whose member_access + member_access_sources row is live   │
 * │  + active. Real orphans get drowned in false positives.                │
 * │                                                                         │
 * │  Fix: cast both columns to ::text in SQL AND coerce both params to    │
 * │  String() in JS — belt-and-suspenders against any pg driver           │
 * │  parameter-type inference.                                            │
 * │                                                                         │
 * │  Governed by: DR-046 (per-person member_access cardinality),          │
 * │               OB-185 (Pass 2 observe-and-log)                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn() },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks:                  jest.fn(),
  getManagedRoleAssignments: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders:      jest.fn(),
  listConfirmedBookings: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(enc => `plain-${enc}`) }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() })),
}));

jest.mock('../../core/trace-context', () => ({
  runWith:     jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-ob225-001'),
  getTraceId:  jest.fn(() => 'trace-ob225-001'),
  getActor:    jest.fn(() => ({ type: 'system', id: 'reconcileMember' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const wixPlansApi     = require('../../adapters/wix/wix-plans-api');
const { eventQueue }  = require('../../core/webhook-processor');
const { log }         = require('../../core/logger');
const reconciliation  = require('../../core/reconciliation');

const CLIENT_ID = 'client-hog-001';
// Numeric IDs as Kisi returns them (JS Number).
const KISI_USER_ID  = 100560021;
const KISI_GROUP_ID = 838622;
const KISI_RA_ID    = '96218158';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[P3] OB-225 — Pass 2 source-lookup type-safe varchar matching', () => {

  test('Pass 2 source-check SQL casts hardware_user_id and hardware_group_id to ::text', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] });
    db.query.mockResolvedValueOnce({
      rows: [{
        id: CLIENT_ID,
        source_site_id: 'wix-site-001',
        source_api_key: 'enc-wix',
        hardware_api_key: 'enc-hw',
        hardware_platform: 'kisi',
        last_active_member_count: 10,
      }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-001' }] });

    wixPlansApi.listActiveOrders.mockResolvedValue([]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    // Kisi returns numeric IDs (this is the wire-format reality).
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: KISI_USER_ID, groupId: KISI_GROUP_ID, roleAssignmentId: KISI_RA_ID },
    ]);

    // kisiUserIds identity lookup (irrelevant to this test — empty)
    db.query.mockResolvedValueOnce({ rows: [] });
    // A12 universe filter — group IS in AccessSync's universe (matches via String() coercion)
    db.query.mockResolvedValueOnce({ rows: [{ hardware_group_id: String(KISI_GROUP_ID) }] });
    // Pass 2 source-check — return a matching row (the bug is in the query SHAPE,
    // not in our ability to mock a result)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mas-row-drew', status: 'active' }] });

    // Remainder of sweep
    db.query.mockResolvedValueOnce({ rows: [] });            // multiMemberPlans
    db.query.mockResolvedValueOnce({ rowCount: 1 });         // last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 });         // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 0 });         // stale in_flight
    db.query.mockResolvedValueOnce({ rows: [] });            // lockdown
    db.query.mockResolvedValueOnce({ rows: [] });            // _fetchActionableRecords
    db.query.mockResolvedValueOnce({ rows: [] });            // digest config
    db.query.mockResolvedValueOnce({ rows: [] });            // digest jobs
    db.query.mockResolvedValueOnce({ rowCount: 1 });         // last_sync_at

    eventQueue.add.mockResolvedValue();

    await reconciliation.runNightlySweep();

    // Find the Pass 2 source-check query
    const sourceCheckCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string'
        && c[0].includes('member_access_sources')
        && c[0].includes('hardware_user_id')
        && c[0].includes('hardware_group_id')
    );
    expect(sourceCheckCall).toBeDefined();

    const sql = sourceCheckCall[0];
    // OB-225 fix — both varchar columns must be explicitly cast to text
    // so the pg driver can never infer an int OID and break the comparison.
    expect(sql).toMatch(/hardware_user_id::text\s*=\s*\$2/);
    expect(sql).toMatch(/hardware_group_id::text\s*=\s*\$3/);

    // Params must be JS strings, not numbers — regardless of what Kisi returns.
    const params = sourceCheckCall[1];
    expect(typeof params[1]).toBe('string');
    expect(typeof params[2]).toBe('string');
    expect(params[1]).toBe(String(KISI_USER_ID));
    expect(params[2]).toBe(String(KISI_GROUP_ID));
  });

  test('matching DB source row does NOT emit reconciliation.unmanaged_assignment_observed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] });
    db.query.mockResolvedValueOnce({
      rows: [{
        id: CLIENT_ID,
        source_site_id: 'wix-site-001',
        source_api_key: 'enc-wix',
        hardware_api_key: 'enc-hw',
        hardware_platform: 'kisi',
        last_active_member_count: 10,
      }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-001' }] });

    wixPlansApi.listActiveOrders.mockResolvedValue([]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    // Kisi returns numeric IDs — Drew's real-world shape.
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: KISI_USER_ID, groupId: KISI_GROUP_ID, roleAssignmentId: KISI_RA_ID },
    ]);

    db.query.mockResolvedValueOnce({ rows: [] });            // kisi identity lookup
    db.query.mockResolvedValueOnce({ rows: [{ hardware_group_id: String(KISI_GROUP_ID) }] }); // A12 universe
    // Pass 2 source-check: row EXISTS — A11 must NOT log
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mas-row-drew', status: 'active' }] });

    db.query.mockResolvedValueOnce({ rows: [] });            // multiMemberPlans
    db.query.mockResolvedValueOnce({ rowCount: 1 });         // last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 });         // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 0 });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    eventQueue.add.mockResolvedValue();

    await reconciliation.runNightlySweep();

    // A11 contract under fix: existing DB source row means NO false-positive log.
    const orphanLog = log.warn.mock.calls.find(c => c[0] === 'reconciliation.unmanaged_assignment_observed');
    expect(orphanLog).toBeUndefined();
  });
});
