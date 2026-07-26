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
const { log }             = require('../../core/logger');

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

  test('stale in_flight reset to recovery_pending targets member_access, not member_access_state', async () => {
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

    // OB-202: stale-lock cleanup now writes 'recovery_pending' (was 'inactive' post-S-11,
    // 'failed' pre-S-11). recovery_pending is the 5th value in the member_access.status
    // CHECK constraint and gets picked up by _fetchActionableRecords on the next sweep.
    const staleCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE') && c[0].includes("status = 'recovery_pending'")
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
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'recovery_pending', member_id: MEMBER_ID, client_id: CLIENT_ID, platform_member_id: PLATFORM_MEMBER_ID }] })
      // _processRecordTargeted error_queue lookup
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })   // digest config_alert
      .mockResolvedValueOnce({ rows: [] })   // digest error_queue
      .mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at

    await reconciliation.runNightlySweep();

    const fetchCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('member_access') && c[0].includes('member_master')
        && c[0].includes("status IN ('recovery_pending'")
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

// ─── OB-185 A11 — Kisi orphan handling (preserves operator-side grants) ──────
// Replaces former OB-74 orphan-revoke behavior. New A11 contract:
//   Kisi has assignment + no matching member_access_sources row →
//   observe + log (config_alert_log target for OB-186 dashboard), NO revoke.
// Operator-side manual grants are preserved indefinitely. AccessSync never
// auto-removes a Kisi assignment we don't have a DB source row for.

describe('[P3] OB-185 A11 — Kisi orphan observed but NOT revoked', () => {

  test('Kisi assignment with no matching source row logs observation, queues NO revoke', async () => {
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

    // Kisi returns one role assignment whose group IS in AccessSync's universe
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'kisi-user-orphan', groupId: 'kisi-group-managed', roleAssignmentId: 'ra-orphan-001' },
    ]);

    // kisiUserIds identity lookup → no DB row (not in kisiMembers map)
    db.query.mockResolvedValueOnce({ rows: [] });

    // A12 universe filter: plan_mappings.hardware_group_id query
    db.query.mockResolvedValueOnce({ rows: [{ hardware_group_id: 'kisi-group-managed' }] });

    // A11 observation: member_access_sources check → NO matching row
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

    // A11 contract: NO revoke event queued for orphan observations.
    const revokeCall = eventQueue.add.mock.calls.find(c => c[0] === 'revoke');
    expect(revokeCall).toBeUndefined();
  });

  test('Kisi assignment OUTSIDE AccessSync universe (group not in plan_mappings) is invisible — no log, no revoke', async () => {
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

    // Kisi returns an assignment for a group AccessSync doesn't provision to
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([
      { userId: 'admin-user', groupId: 'kisi-group-staff-only', roleAssignmentId: 'ra-admin-999' },
    ]);

    db.query.mockResolvedValueOnce({ rows: [] }); // kisiUserIds identity lookup
    db.query.mockResolvedValueOnce({ rows: [{ hardware_group_id: 'kisi-group-managed' }] }); // A12 universe — staff group NOT in set
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // update last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 0 }); // stale in_flight
    db.query.mockResolvedValueOnce({ rows: [] }); // _syncDoorLockdownStates
    db.query.mockResolvedValueOnce({ rows: [] }); // _fetchActionableRecords
    db.query.mockResolvedValueOnce({ rows: [] }); // digest configAlerts
    db.query.mockResolvedValueOnce({ rows: [] }); // digest failedJobs
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at

    eventQueue.add.mockResolvedValue();
    await reconciliation.runNightlySweep();

    // A12: staff-group assignment never even reaches the source-check query
    const sourceCheckCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string'
        && c[0].includes('member_access_sources')
        && c[0].includes('hardware_user_id')
    );
    expect(sourceCheckCall).toBeUndefined();
    // And no revoke queued
    expect(eventQueue.add.mock.calls.find(c => c[0] === 'revoke')).toBeUndefined();
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

    // OB-74: member_access_sources check → row EXISTS → no orphan
    db.query.mockResolvedValueOnce({ rows: [{ id: 'mas-row-001' }] });

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

// ─── DR-049 — multi-member holders auto-grant on nightly/manual sync ────────
// Removes the sweep's own invented "opt-in" skip (misattributed to "DR-040" in code
// comments — DR-040 is a schema/quota decision, not behavioral). The real-time Wix
// webhook path has never had an opt-in check; this closes the divergence so a member
// whose original webhook grant failed gets it correctly restored by this sweep too.

describe('[P3] DR-049 — multi-member plan holder auto-grants via nightly/manual sync', () => {

  test('a Wix order for a multi-member-eligible plan queues a grant, not a skip', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] }); // gate

    db.query.mockResolvedValueOnce({
      rows: [{
        id: CLIENT_ID,
        source_site_id: 'wix-site-001',
        source_api_key: 'enc-wix',
        hardware_api_key: 'enc-hw',
        hardware_platform: 'kisi',
        last_active_member_count: 10,
      }],
    }); // _syncTrueSources

    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-001' }] }); // reconciliation_run INSERT

    // A brand-new buyer of a multi-member-eligible plan — in Wix, not yet in Kisi.
    wixPlansApi.listActiveOrders.mockResolvedValue([
      { memberId: 'wix-member-new-buyer', planId: 'wix-plan-family', email: 'buyer@test.com', name: 'New Buyer' },
    ]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);

    // Nobody in Kisi yet — kisiUserIds.length===0 skips the identity lookup query,
    // and the empty kisiAssignments loop skips the A11 source-check query too.
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([]);

    db.query.mockResolvedValueOnce({ rows: [] }); // A12 universe filter (accessSyncGroupsResult) — always runs

    // update last_active_member_count
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    // close reconciliation_run
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    db.query.mockResolvedValueOnce({ rowCount: 0 }); // stale in_flight
    db.query.mockResolvedValueOnce({ rows: [] });    // lockdown
    db.query.mockResolvedValueOnce({ rows: [] });    // actionable
    db.query.mockResolvedValueOnce({ rows: [] });    // digest config
    db.query.mockResolvedValueOnce({ rows: [] });    // digest jobs
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at

    eventQueue.add.mockResolvedValue();

    await reconciliation.runNightlySweep();

    const grantCall = eventQueue.add.mock.calls.find(
      c => c[0] === 'grant' && c[1]?.standardEvent?.planId === 'wix-plan-family'
    );
    expect(grantCall).toBeDefined();
    expect(grantCall[1].standardEvent.platformMemberId).toBe('wix-member-new-buyer');
    expect(grantCall[1].standardEvent.syntheticSource).toBe('reconciliation.true_source_sync');

    // The removed opt-in skip must never fire again.
    expect(log.info).not.toHaveBeenCalledWith('reconciliation.grant_skipped_optin', expect.anything());
  });

  test('skippedHolderOptin is always 0 in the return shape (kept for caller compatibility)', async () => {
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

    wixPlansApi.listActiveOrders.mockResolvedValue([
      { memberId: 'wix-member-new-buyer-2', planId: 'wix-plan-family', email: 'buyer2@test.com', name: 'Buyer Two' },
    ]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([]);

    db.query.mockResolvedValueOnce({ rows: [] }); // A12 universe filter
    db.query.mockResolvedValue({ rowCount: 1 });  // last_active_member_count + anything after (no runId, so no reconciliation_run close)

    eventQueue.add.mockResolvedValue();

    const result = await reconciliation._syncClient(
      { id: CLIENT_ID, source_site_id: 'wix-site-001', source_api_key: 'enc-wix',
        hardware_api_key: 'enc-hw', hardware_platform: 'kisi', last_active_member_count: 10 },
      { triggeredBy: 'manual', triggeredByActor: { type: 'operator', id: 'test' } }
    );

    expect(result.skippedHolderOptin).toBe(0);
    expect(result.granted).toBeGreaterThan(0);
  });
});

// ─── OB-202 — recovery_pending status as transient retry state ──────────────

describe('[P3] OB-202 — recovery_pending status', () => {

  // OB-202 Test A (assert recovery_pending in WHERE clause) is covered by the existing
  // 'actionable records query uses member_access JOIN member_master' test at line ~115
  // which already asserts `status IN ('recovery_pending'` post-Ship-B. The dedicated direct
  // invocation of `_fetchActionableRecords()` was redundant and brittle to mock-queue state
  // across the full-file run. Coverage retained; assertion lives upstream.

  it('OB-202/OB-204: stale lock cleanup writes status=recovery_pending via standardAdapter.releaseStaleLocks', async () => {
    // Drive runNightlySweep with no work so the stale UPDATE is the only mutation of interest.
    db.query
      .mockResolvedValueOnce({ rows: [{ last_sync_at: null, interval: 'daily' }] }) // gate
      .mockResolvedValueOnce({ rows: [] })   // _syncTrueSources clients
      .mockResolvedValueOnce({ rowCount: 0 }) // stale in_flight UPDATE
      .mockResolvedValueOnce({ rows: [] })   // _syncDoorLockdownStates
      .mockResolvedValueOnce({ rows: [] })   // _fetchActionableRecords
      .mockResolvedValueOnce({ rows: [] })   // digest config_alert
      .mockResolvedValueOnce({ rows: [] })   // digest error_queue
      .mockResolvedValueOnce({ rowCount: 1 }); // last_sync_at UPDATE

    await reconciliation.runNightlySweep();

    const updateCall = db.query.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes("SET status = 'recovery_pending'")
    );
    expect(updateCall).toBeDefined();
    const sqlText = updateCall[0];
    expect(sqlText).toMatch(/SET status = 'recovery_pending'/);
    expect(sqlText).toMatch(/WHERE status = 'in_flight'/);
    expect(sqlText).not.toMatch(/SET status = 'inactive'/);
  });
});
