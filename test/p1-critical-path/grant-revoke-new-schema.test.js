/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: grant-revoke.js against new schema                           │
 * │                                                                         │
 * │  Replaces: grant-retry-idempotency.test.js + ob-125-source-tag-guard   │
 * │            (both SKIPped in S-3, un-skipped in S-8)                     │
 * │                                                                         │
 * │  Tests the new-schema SQL shapes:                                       │
 * │    - member_access_sources via access_id (not member_id)                │
 * │    - role_assignment_id direct on member_access_sources (no MRA join)   │
 * │    - processRevoke DELETE + COUNT via access_id                         │
 * │    - OB-125: source_tag from member_master via member_access JOIN       │
 * │    - DR-044: UPDATE member_master PII NULL via member_access subquery   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole:    jest.fn(),
  removeRole:    jest.fn(),
  deleteUser:    jest.fn(),
  suspendAccess: jest.fn(),
  enableAccess:  jest.fn(),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-s3-001'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const MEMBER_ID   = 'ma-uuid-001';        // member_access.id (new schema)
const TENANT_ID   = 'client-hog-001';
const MAPPING_ID  = 'mapping-uuid-001';
const GROUP_ID    = 'kisi-group-42';
const RA_ID       = 'kisi-ra-99561847';
const PLAN_ID     = 'wix-plan-aaa';

const baseMapping = {
  mappingId:        MAPPING_ID,
  hardwarePlatform: 'kisi',
  hardwareGroupId:  GROUP_ID,
  apiKey:           'kisi-api-key',
  accessType:       'permanent',
};

const baseEvent = {
  eventType:        'plan.purchased',
  platformMemberId: 'wix-member-abc',
  planId:           PLAN_ID,
};

beforeEach(() => {
  jest.resetAllMocks();
});

// ─── OB-47: source check uses access_id, role_assignment_id direct ──────────

describe('[P1] processGrant — OB-47 source check against new schema', () => {

  test('skips hardware call when member_access_sources has existing role_assignment_id via access_id', async () => {
    // First query: source check (new schema — access_id FK, role_assignment_id direct)
    db.query
      .mockResolvedValueOnce({ rows: [{ source_plan_id: PLAN_ID, source_type: 'plan', role_assignment_id: RA_ID }] })
      // member_access_log INSERT
      .mockResolvedValueOnce({ rowCount: 1 });

    const assignments = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [baseMapping], baseEvent
    );

    expect(hardwareAdapter.assignRole).not.toHaveBeenCalled();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].roleAssignmentId).toBe(String(RA_ID));
    expect(assignments[0].accessId).toBe(MEMBER_ID);

    // Verify the source check SQL uses access_id, not member_id
    const sourceCheckCall = db.query.mock.calls[0];
    expect(sourceCheckCall[0]).toMatch(/FROM member_access_sources/);
    expect(sourceCheckCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(sourceCheckCall[0]).not.toMatch(/member_role_assignments/);
    expect(sourceCheckCall[1]).toEqual([MEMBER_ID, GROUP_ID]);
  });

  test('proceeds to hardware call when no existing source row found', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })          // source check: no row (access_id path)
      .mockResolvedValueOnce({ rows: [] })          // idempotency check: no row (access_id path)
      .mockResolvedValueOnce({ rowCount: 1 });      // member_access_log INSERT

    hardwareAdapter.assignRole.mockResolvedValue(RA_ID);

    const assignments = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [baseMapping], baseEvent
    );

    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith('kisi', 'kisi-api-key', 'kisi-user-99', GROUP_ID);
    expect(assignments[0].accessId).toBe(MEMBER_ID);
    expect(assignments[0].roleAssignmentId).toBe(String(RA_ID));

    // Verify idempotency check also uses new schema (access_id, not member_id)
    const idempotencyCall = db.query.mock.calls[1];
    expect(idempotencyCall[0]).toMatch(/FROM member_access_sources/);
    expect(idempotencyCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(idempotencyCall[0]).not.toMatch(/member_role_assignments/);
  });
});

// ─── processRevoke plan.cancelled — new schema ──────────────────────────────

describe('[P1] processRevoke — plan.cancelled against new schema (access_id FK)', () => {

  const cancelEvent = { ...baseEvent, eventType: 'plan.cancelled', rawEventType: 'orderCanceled' };

  test('calls removeRole when no remaining sources after DELETE', async () => {
    db.query
      // _getClientApiKey
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      // raWithGroups SELECT (new schema: FROM member_access_sources WHERE access_id = $1)
      .mockResolvedValueOnce({ rows: [{ role_assignment_id: RA_ID, hardware_group_id: GROUP_ID, mapping_id: MAPPING_ID }] })
      // DELETE (access_id = $1)
      .mockResolvedValueOnce({ rowCount: 1 })
      // COUNT remaining (access_id = $1) → 0
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      // member_access_log INSERT
      .mockResolvedValueOnce({ rowCount: 1 })
      // DR-044 finalize UPDATE → no sub-member match
      .mockResolvedValueOnce({ rowCount: 0 })
      // DR-044 state check
      .mockResolvedValueOnce({ rows: [{ plan_holder_id: null, sub_member_status: null }] });

    hardwareAdapter.removeRole.mockResolvedValue();

    const status = await grantRevoke.processRevoke(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', cancelEvent
    );

    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith('kisi', null, RA_ID);
    expect(status).toBe('inactive');

    // Verify SELECT uses access_id
    const selectCall = db.query.mock.calls[1];
    expect(selectCall[0]).toMatch(/FROM member_access_sources/);
    expect(selectCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(selectCall[0]).not.toMatch(/member_role_assignments/);

    // Verify DELETE uses access_id
    const deleteCall = db.query.mock.calls[2];
    expect(deleteCall[0]).toMatch(/DELETE FROM member_access_sources/);
    expect(deleteCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(deleteCall[1][0]).toBe(MEMBER_ID);

    // Verify COUNT uses access_id
    const countCall = db.query.mock.calls[3];
    expect(countCall[0]).toMatch(/COUNT\(\*\)/);
    expect(countCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(countCall[1][0]).toBe(MEMBER_ID);
  });

  test('skips removeRole when remaining sources > 0 after DELETE', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      .mockResolvedValueOnce({ rows: [{ role_assignment_id: RA_ID, hardware_group_id: GROUP_ID, mapping_id: MAPPING_ID }] })
      .mockResolvedValueOnce({ rowCount: 1 })             // DELETE
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })    // COUNT → 2 remaining
      .mockResolvedValueOnce({ rowCount: 1 })             // member_access_log INSERT
      .mockResolvedValueOnce({ rowCount: 0 })             // DR-044 finalize → no sub-member
      .mockResolvedValueOnce({ rows: [{ plan_holder_id: null }] });

    const status = await grantRevoke.processRevoke(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', cancelEvent
    );

    expect(hardwareAdapter.removeRole).not.toHaveBeenCalled();
    expect(status).toBe('inactive');
  });
});

// ─── OB-125: source_tag from member_master via JOIN ─────────────────────────

describe('[P1] processRevoke — OB-125 source_tag guard from member_master (new schema)', () => {

  const deletedEvent = { ...baseEvent, eventType: 'member.deleted', platformMemberId: 'wix-member-abc' };

  test('calls deleteUser when source_tag = accesssync (from member_master JOIN)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      // source_tag SELECT (new schema: JOIN member_master via member_access)
      .mockResolvedValueOnce({ rows: [{ source_tag: 'accesssync' }] })
      .mockResolvedValueOnce({ rowCount: 1 })  // member_access_log
      .mockResolvedValueOnce({ rowCount: 1 }); // config_alert_log

    hardwareAdapter.deleteUser.mockResolvedValue();

    await grantRevoke.processRevoke(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [], 'kisi', 'member.deleted', deletedEvent
    );

    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith('kisi', null, 'kisi-user-99', { clientId: TENANT_ID });

    // Verify source_tag query uses member_master JOIN, not member_identity
    const tagCall = db.query.mock.calls[1];
    expect(tagCall[0]).toMatch(/FROM member_master/);
    expect(tagCall[0]).toMatch(/JOIN member_access/);
    expect(tagCall[0]).not.toMatch(/member_identity/);
    expect(tagCall[1]).toEqual([MEMBER_ID]);
  });

  test('skips deleteUser when source_tag != accesssync', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      .mockResolvedValueOnce({ rows: [{ source_tag: 'manual' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await grantRevoke.processRevoke(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [], 'kisi', 'member.deleted', deletedEvent
    );

    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
  });
});

// DR-044 sub-member finalize block was removed from grant-revoke.js (2026-05-07).
// It referenced non-existent columns (member_master.plan_holder_id, sub_member_status).
// Sub-member soft-delete is owned by the Member Hub DELETE endpoint, not the webhook revoke path.
