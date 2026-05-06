/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: New schema concept invariants (S-8)                          │
 * │                                                                         │
 * │  These tests cover schema concepts that have no legacy equivalent —     │
 * │  member_billing idempotency, access→billing link at grant time,         │
 * │  revoke source-count guard, and member_master UPSERT idempotency.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
  suspendAccess:   jest.fn(),
  enableAccess:    jest.fn(),
  deleteUser:      jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: jest.fn(key => `enc:${key}`),
  decryptApiKey: jest.fn(enc => enc.replace('enc:', '')),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const standardAdapter = require('../../adapters/standard-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const {
  HOG_CLIENT_ID,
  MEMBER_INTERNAL_ID,
  KISI_HARDWARE_USER_ID,
  KISI_ROLE_ASSIGNMENT_ID,
  KISI_GROUP_ID,
  ENCRYPTED_API_KEY_DB_VALUE,
} = require('../helpers/fixtures');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

// ─── 1. member_billing renewal idempotency ───────────────────────────────────

describe('[P3] member_billing renewal idempotency — same (wix_order_id, cycle_index) must not duplicate', () => {

  it('completeGrant handles DO NOTHING on duplicate (wix_order_id, cycle_index) by fetching existing id', async () => {
    const memberId = MEMBER_INTERNAL_ID;
    const tenantId = HOG_CLIENT_ID;

    db.query
      // SELECT member_master_id FROM member_access
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-uuid-001' }] })
      // INSERT INTO member_billing — ON CONFLICT DO NOTHING fires (no RETURNING row)
      .mockResolvedValueOnce({ rows: [] })
      // SELECT id FROM member_billing WHERE wix_order_id AND cycle_index (fetch existing)
      .mockResolvedValueOnce({ rows: [{ id: 'billing-uuid-existing' }] })
      // INSERT INTO member_access_sources
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE member_access SET status = 'active'
      .mockResolvedValueOnce({ rows: [] })
      // _incrementActivity + _maybeFireFirstGrantEmail (fire-and-forget)
      .mockResolvedValue({ rows: [] });

    const assignments = [{
      mappingId:       'pm-001',
      roleAssignmentId: KISI_ROLE_ASSIGNMENT_ID,
      hardwareGroupId: KISI_GROUP_ID,
      sourcePlanId:    'plan-xyz',
      sourceType:      'plan',
      wixOrderId:      'order-abc',
      cycleIndex:      1,
      planEndDate:     null,
    }];

    await expect(
      standardAdapter.completeGrant(memberId, tenantId, assignments)
    ).resolves.not.toThrow();

    // The billing INSERT must include ON CONFLICT (wix_order_id, cycle_index) DO NOTHING
    const billingInsert = db.query.mock.calls.find(
      c => c[0] && c[0].includes('member_billing') && c[0].includes('INSERT')
    );
    expect(billingInsert).toBeDefined();
    expect(billingInsert[0]).toMatch(/ON CONFLICT.*DO NOTHING/s);
  });

});

// ─── 2. member_access_sources billing link at grant time ────────────────────

describe('[P3] member_access_sources.billing_id is written at grant time — access→billing link', () => {

  it('completeGrant writes billing_id onto the member_access_sources row', async () => {
    const memberId = MEMBER_INTERNAL_ID;
    const tenantId = HOG_CLIENT_ID;
    const billingId = 'billing-uuid-new';

    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-uuid-001' }] }) // member_master_id
      .mockResolvedValueOnce({ rows: [{ id: billingId }] })                   // INSERT member_billing RETURNING id
      .mockResolvedValueOnce({ rows: [] })                                    // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                    // UPDATE member_access
      .mockResolvedValue({ rows: [] });

    const assignments = [{
      mappingId:       'pm-001',
      roleAssignmentId: KISI_ROLE_ASSIGNMENT_ID,
      hardwareGroupId: KISI_GROUP_ID,
      sourcePlanId:    'plan-xyz',
      sourceType:      'plan',
      wixOrderId:      'order-abc',
      cycleIndex:      2,
      planEndDate:     null,
    }];

    await standardAdapter.completeGrant(memberId, tenantId, assignments);

    const sourcesInsert = db.query.mock.calls.find(
      c => c[0] && c[0].includes('member_access_sources') && c[0].includes('INSERT')
    );
    expect(sourcesInsert).toBeDefined();
    // billing_id must be in the VALUES list ($2 position based on the INSERT shape)
    expect(sourcesInsert[1]).toContain(billingId);
  });

});

// ─── 3. Revoke with no remaining billing sources → hardware removeRole fires ─

describe('[P3] Revoke guard: hardware removeRole fires when no remaining sources for a group', () => {

  it('calls removeRole when member_access_sources count reaches 0 after DELETE', async () => {
    hardwareAdapter.removeRole.mockResolvedValue(null);

    db.query
      // _getClientApiKey
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] })
      // SELECT ... FROM member_access_sources — 1 row
      .mockResolvedValueOnce({ rows: [
        { role_assignment_id: KISI_ROLE_ASSIGNMENT_ID, hardware_group_id: KISI_GROUP_ID, mapping_id: 'pm-1' },
      ]})
      // DELETE member_access_sources
      .mockResolvedValueOnce({ rowCount: 1 })
      // SELECT COUNT(*) remaining → 0 → removeRole must fire
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      // Sub-member finalize → not a sub-member
      .mockResolvedValueOnce({ rowCount: 0 })
      // member_access_log INSERT (revoked)
      .mockResolvedValue({ rows: [] });

    const event = {
      eventType: 'plan.cancelled',
      planId: 'plan-xyz',
      platformMemberId: 'wix-member-abc',
    };

    await grantRevoke.processRevoke(
      HOG_CLIENT_ID, MEMBER_INTERNAL_ID, KISI_HARDWARE_USER_ID,
      [], 'kisi', 'plan.cancelled', event
    );

    expect(hardwareAdapter.removeRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith(
      'kisi', expect.any(String), KISI_ROLE_ASSIGNMENT_ID
    );
  });

});

// ─── 4. Revoke with remaining active billing sources → removeRole skipped ────

describe('[P3] Revoke guard: hardware removeRole is suppressed when other billing sources remain', () => {

  it('does NOT call removeRole when remaining source count > 0 after DELETE', async () => {
    hardwareAdapter.removeRole.mockResolvedValue(null);

    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] })
      .mockResolvedValueOnce({ rows: [
        { role_assignment_id: KISI_ROLE_ASSIGNMENT_ID, hardware_group_id: KISI_GROUP_ID, mapping_id: 'pm-1' },
      ]})
      .mockResolvedValueOnce({ rowCount: 1 })
      // Count = 2 → another active source still present → removeRole skipped
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }] })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValue({ rows: [] });

    const event = {
      eventType: 'plan.cancelled',
      planId: 'plan-xyz',
      platformMemberId: 'wix-member-abc',
    };

    const result = await grantRevoke.processRevoke(
      HOG_CLIENT_ID, MEMBER_INTERNAL_ID, KISI_HARDWARE_USER_ID,
      [], 'kisi', 'plan.cancelled', event
    );

    expect(hardwareAdapter.removeRole).not.toHaveBeenCalled();
    expect(result).toBe('revoked');
  });

});

// ─── 5. member_master UPSERT idempotency ────────────────────────────────────

describe('[P3] member_master UPSERT idempotency — same (client_id, platform, member_id) must not duplicate', () => {

  it('resolveAndLock grant path uses ON CONFLICT to prevent duplicate member_master rows', async () => {
    const mockClient = {
      query:   jest.fn(),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                         // BEGIN
      // INSERT INTO member_master ON CONFLICT DO UPDATE → returns id
      .mockResolvedValueOnce({ rows: [{ id: 'mm-uuid-001' }] })
      // SELECT id FROM member_access FOR UPDATE NOWAIT → no existing row (no lock conflict)
      .mockResolvedValueOnce({ rows: [] })
      // INSERT INTO member_access ON CONFLICT DO UPDATE → returns id + hardware_user_id
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_INTERNAL_ID, hardware_user_id: null }] })
      .mockResolvedValueOnce({ rows: [] });  // COMMIT

    // fire-and-forget _incrementActivity + setTraceContext
    db.query.mockResolvedValue({ rows: [] });

    const event = {
      platformMemberId: 'wix-member-abc',
      sourcePlatform:   'wix',
      planMappingId:    'pm-uuid-001',
    };

    const result = await standardAdapter.resolveAndLock(HOG_CLIENT_ID, event, 'kisi');

    expect(result.memberId).toBe(MEMBER_INTERNAL_ID);

    // The member_master INSERT must use ON CONFLICT to be idempotent
    const masterInsert = mockClient.query.mock.calls.find(
      c => c[0] && c[0].includes('member_master') && c[0].includes('INSERT')
    );
    expect(masterInsert).toBeDefined();
    expect(masterInsert[0]).toMatch(/ON CONFLICT.*DO UPDATE/s);
  });

});
