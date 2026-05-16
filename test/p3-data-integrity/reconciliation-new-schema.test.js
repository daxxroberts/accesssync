/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: reconciliation.js against new schema                         │
 * │                                                                         │
 * │  Tests the new-schema SQL shapes:                                       │
 * │    - Stale lock: UPDATE member_access (not member_access_state)         │
 * │    - _fetchActionableRecords: member_access JOIN member_master          │
 * │    - reconcileMember: member_master + member_access (not member_identity)│
 * │    - DB drift check: member_access_sources WHERE access_id (not member_id)│
 * │    - OB-74: Kisi orphan → synthetic revoke queued when no MAS row      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn() },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks:                     jest.fn(),
  getManagedRoleAssignments:    jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders:       jest.fn(),
  listConfirmedBookings:  jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({
  resolve: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(enc => `plain-${enc}`),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() })),
}));

jest.mock('../../core/trace-context', () => ({
  runWith:       jest.fn((ctx, fn) => fn()),
  mintTraceId:   jest.fn(() => 'trace-s4-recon-001'),
  getTraceId:    jest.fn(() => 'trace-s4-recon-001'),
  getActor:      jest.fn(() => ({ type: 'system', id: 'reconcileMember' })),
}));

const db                  = require('../../db');
const hardwareAdapter     = require('../../adapters/hardware-adapter');
const wixPlansApi         = require('../../adapters/wix/wix-plans-api');
const planMappingResolver = require('../../core/plan-mapping-resolver');
const { eventQueue }      = require('../../core/webhook-processor');
const reconciliation      = require('../../core/reconciliation');

const CLIENT_ID  = 'client-hog-001';
const MEMBER_ID  = 'ma-uuid-001';           // member_access.id
const MM_ID      = 'mm-uuid-001';           // member_master.id
const PLATFORM_MEMBER_ID = 'wix-member-abc';
const GROUP_ID   = 'kisi-group-42';
const MAPPING_ID = 'mapping-uuid-001';
const RA_ID      = 'kisi-ra-99561847';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Stale lock cleanup — member_access (not member_access_state) ─────────────

describe('[P3] Stale lock cleanup — UPDATE member_access (new schema)', () => {

  test('stale in_flight reset targets member_access, not member_access_state', async () => {
    // Recurrence gate: last_sync_at is old enough to proceed
    db.query
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] })  // gate
      // _syncTrueSources clients query
      .mockResolvedValueOnce({ rows: [] })
      // stale in_flight UPDATE
      .mockResolvedValueOnce({ rowCount: 0 })
      // _syncDoorLockdownStates locations
      .mockResolvedValueOnce({ rows: [] })
      // _fetchActionableRecords
      .mockResolvedValueOnce({ rows: [] })
      // digest config_alert_log
      .mockResolvedValueOnce({ rows: [] })
      // digest error_queue
      .mockResolvedValueOnce({ rows: [] })
      // last_sync_at UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    await reconciliation.runNightlySweep();

    // S-11/DR-046: stale-lock cleanup now writes 'inactive' (was 'failed' pre-S-11).
    // Status enum collapsed to 4 values; per-plan failure lives on member_access_sources.
    const staleCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE') && c[0].includes("status = 'inactive'")
        && c[0].includes('member_access') && c[0].includes("status = 'in_flight'")
    );
    expect(staleCall).toBeDefined();
    expect(staleCall[0]).toMatch(/UPDATE member_access/);
    expect(staleCall[0]).not.toMatch(/member_access_state/);
    expect(staleCall[0]).toMatch(/status = 'in_flight'/);
  });
});

// ─── _fetchActionableRecords — member_access JOIN member_master ───────────────

describe('[P3] _fetchActionableRecords — member_access JOIN member_master (new schema)', () => {

  test('actionable records query uses member_access JOIN member_master, not member_access_state', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] })
      .mockResolvedValueOnce({ rows: [] })   // _syncTrueSources
      .mockResolvedValueOnce({ rowCount: 0 }) // stale update
      .mockResolvedValueOnce({ rows: [] })   // _syncDoorLockdownStates
      // _fetchActionableRecords
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'failed', member_id: MEMBER_ID, client_id: CLIENT_ID, platform_member_id: PLATFORM_MEMBER_ID }] })
      // _processRecordTargeted error_queue lookup
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })   // digest config_alert
      .mockResolvedValueOnce({ rows: [] })   // digest error_queue
      .mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at

    await reconciliation.runNightlySweep();

    const fetchCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('member_access') && c[0].includes('member_master')
        && c[0].includes("status IN ('failed'")
    );
    expect(fetchCall).toBeDefined();
    expect(fetchCall[0]).toMatch(/FROM member_access/);
    expect(fetchCall[0]).toMatch(/JOIN member_master/);
    expect(fetchCall[0]).not.toMatch(/member_access_state/);
    expect(fetchCall[0]).not.toMatch(/member_identity/);
  });
});

// ─── reconcileMember — member_master + member_access (not member_identity) ───

describe('[P3] reconcileMember — member_master + member_access (new schema)', () => {

  test('identity load queries member_access JOIN member_master, not member_identity', async () => {
    // client query
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: CLIENT_ID, source_site_id: 'wix-site-001', source_api_key: 'enc-wix', hardware_api_key: 'enc-hw', hardware_platform: 'kisi' }],
      })
      // identity query
      .mockResolvedValueOnce({ rows: [] }); // no record → no_identity

    const result = await reconciliation.reconcileMember(MEMBER_ID, CLIENT_ID);

    expect(result.action).toBe('no_identity');

    const identityCall = db.query.mock.calls[1];
    expect(identityCall[0]).toMatch(/FROM member_access/);
    expect(identityCall[0]).toMatch(/JOIN member_master/);
    expect(identityCall[0]).not.toMatch(/member_identity/);
    expect(identityCall[1]).toEqual([MEMBER_ID, CLIENT_ID]);
  });

  test('DB drift check uses member_access_sources WHERE access_id, not member_id', async () => {
    // client
    db.query.mockResolvedValueOnce({
      rows: [{ id: CLIENT_ID, source_site_id: 'wix-site-001', source_api_key: 'enc-wix', hardware_api_key: 'enc-hw', hardware_platform: 'kisi' }],
    });
    // identity (member_access JOIN member_master)
    db.query.mockResolvedValueOnce({
      rows: [{ id: MEMBER_ID, platform_member_id: PLATFORM_MEMBER_ID, hardware_user_id: 'kisi-user-99', sub_master_id: null, source_tag: 'accesssync' }],
    });

    wixPlansApi.listActiveOrders.mockResolvedValue([{ memberId: PLATFORM_MEMBER_ID, planId: 'wix-plan-aaa', email: 'test@test.com', name: 'Test' }]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    planMappingResolver.resolve.mockResolvedValue([{
      mappingId: MAPPING_ID,
      hardwareGroupId: GROUP_ID,
      hardwarePlatform: 'kisi',
    }]);

    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'kisi-user-99', groupId: GROUP_ID },
    ]);

    // DB drift: member_access_sources WHERE access_id = $1
    db.query.mockResolvedValueOnce({ rows: [{ hardware_group_id: GROUP_ID }] });

    const result = await reconciliation.reconcileMember(MEMBER_ID, CLIENT_ID);

    expect(result.action).toBe('ok');

    const driftCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('member_access_sources') && c[0].includes('access_id')
    );
    expect(driftCall).toBeDefined();
    expect(driftCall[0]).toMatch(/FROM member_access_sources/);
    expect(driftCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(driftCall[0]).not.toMatch(/member_id\s*=\s*\$1/);
    expect(driftCall[1]).toEqual([MEMBER_ID]);
  });

  test('missing member_access_sources row triggers repair action', async () => {
    // client
    db.query.mockResolvedValueOnce({
      rows: [{ id: CLIENT_ID, source_site_id: 'wix-site-001', source_api_key: 'enc-wix', hardware_api_key: 'enc-hw', hardware_platform: 'kisi' }],
    });
    // identity
    db.query.mockResolvedValueOnce({
      rows: [{ id: MEMBER_ID, platform_member_id: PLATFORM_MEMBER_ID, hardware_user_id: 'kisi-user-99', sub_master_id: null, source_tag: 'accesssync' }],
    });

    wixPlansApi.listActiveOrders.mockResolvedValue([{ memberId: PLATFORM_MEMBER_ID, planId: 'wix-plan-aaa', email: 'test@test.com', name: 'Test' }]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    planMappingResolver.resolve.mockResolvedValue([{
      mappingId: MAPPING_ID,
      hardwareGroupId: GROUP_ID,
      hardwarePlatform: 'kisi',
    }]);

    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'kisi-user-99', groupId: GROUP_ID },
    ]);

    // member_access_sources has NO row for this access_id → drift detected
    db.query.mockResolvedValueOnce({ rows: [] });

    eventQueue.add.mockResolvedValue();

    const result = await reconciliation.reconcileMember(MEMBER_ID, CLIENT_ID);

    expect(result.action).toBe('repaired');
    expect(result.repaired).toBe(1);
    expect(eventQueue.add).toHaveBeenCalledWith('grant', expect.objectContaining({ tenantId: CLIENT_ID }), expect.any(Object));
  });
});

// ─── OB-74: bi-directional Kisi→Wix sweep ────────────────────────────────────

describe('[P3] OB-74 bi-directional — Kisi orphan queues synthetic revoke', () => {

  test('Kisi assignment with no member_access_sources row triggers revoke', async () => {
    // Gate: last_sync_at old enough
    db.query.mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] });

    // _syncTrueSources: one client with source creds
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

    // reconciliation_run INSERT
    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-001' }] });

    wixPlansApi.listActiveOrders.mockResolvedValue([]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    // Kisi returns one role assignment
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'kisi-user-orphan', groupId: 'kisi-group-orphan' },
    ]);

    // kisiUserIds identity lookup → no DB row (not in kisiMembers map)
    db.query.mockResolvedValueOnce({ rows: [] });

    // OB-74: member_access_sources check → NO matching row (runs before multiMemberPlans)
    db.query.mockResolvedValueOnce({ rows: [] });

    // OB-74: member_access lookup for platform_member_id
    db.query.mockResolvedValueOnce({ rows: [{ platform_member_id: PLATFORM_MEMBER_ID }] });

    // multiMemberPlans (3A opt-in guard — wixMembers empty so loop is a no-op, but query still runs)
    db.query.mockResolvedValueOnce({ rows: [] });

    // update last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    // stale in_flight UPDATE
    db.query.mockResolvedValueOnce({ rowCount: 0 });
    // _syncDoorLockdownStates
    db.query.mockResolvedValueOnce({ rows: [] });
    // _fetchActionableRecords
    db.query.mockResolvedValueOnce({ rows: [] });
    // digest
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    // last_sync_at
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    eventQueue.add.mockResolvedValue();

    await reconciliation.runNightlySweep();

    // Verify the member_access_sources check used access_id
    const masCheckCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('member_access_sources') && c[0].includes('access_id')
        && c[0].includes('hardware_user_id')
    );
    expect(masCheckCall).toBeDefined();

    // Verify revoke was queued
    const revokeCall = eventQueue.add.mock.calls.find(c => c[0] === 'revoke');
    expect(revokeCall).toBeDefined();
    expect(revokeCall[1]).toMatchObject({
      tenantId: CLIENT_ID,
      standardEvent: expect.objectContaining({
        eventType: 'plan.cancelled',
        syntheticSource: 'reconciliation.kisi_orphan',
      }),
    });
  });

  test('Kisi assignment WITH matching member_access_sources row does NOT queue revoke', async () => {
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

    wixPlansApi.listActiveOrders.mockResolvedValue([{ memberId: PLATFORM_MEMBER_ID, planId: 'wix-plan-aaa' }]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'kisi-user-99', groupId: GROUP_ID },
    ]);

    // identity lookup → maps kisi-user-99 to PLATFORM_MEMBER_ID
    db.query.mockResolvedValueOnce({
      rows: [{ platform_member_id: PLATFORM_MEMBER_ID, sub_master_id: null }],
    });

    // OB-74: member_access_sources check → row EXISTS → no orphan (runs before multiMemberPlans)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mas-row-001' }] });

    // multiMemberPlans (3A opt-in guard)
    db.query.mockResolvedValueOnce({ rows: [] });

    // update last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    db.query.mockResolvedValueOnce({ rowCount: 0 }); // stale
    db.query.mockResolvedValueOnce({ rows: [] });     // lockdown
    db.query.mockResolvedValueOnce({ rows: [] });     // actionable
    db.query.mockResolvedValueOnce({ rows: [] });     // digest config
    db.query.mockResolvedValueOnce({ rows: [] });     // digest jobs
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at

    eventQueue.add.mockResolvedValue();

    await reconciliation.runNightlySweep();

    const revokeCall = eventQueue.add.mock.calls.find(
      c => c[0] === 'revoke' && c[1]?.standardEvent?.syntheticSource === 'reconciliation.kisi_orphan'
    );
    expect(revokeCall).toBeUndefined();
  });
});
