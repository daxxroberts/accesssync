/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: processGrant idempotency on retry                            │
 * │                                                                         │
 * │  Business consequence: When completeGrant crashes after writing the    │
 * │  member_role_assignments row (e.g. OB-46 missing table, transient DB   │
 * │  error), BullMQ retries the whole job. Before this guard, the retry    │
 * │  called kisi.assignRole a second time and Kisi correctly returned a   │
 * │  409 Conflict — the role_assignment already existed server-side. The  │
 * │  whole job then dead-lettered as HARDWARE_API_ERROR even though the   │
 * │  member had working access.                                            │
 * │                                                                         │
 * │  Fix: before calling assignRole, check member_role_assignments for    │
 * │  a pre-existing row matching (member_id, mapping_id, hardware_group_id) │
 * │  and reuse its role_assignment_id if found. Makes processGrant fully  │
 * │  idempotent.                                                            │
 * │                                                                         │
 * │  Root cause: observed in HOG prod 2026-04-18T23:32 for member          │
 * │  7af07f2c when OB-46 migration was missing; completeGrant crashed on  │
 * │  42P01 after Kisi assignRole succeeded; retry hit Kisi 409.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({
  resolve: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `plaintext-${enc}`),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const TENANT_ID   = 'client-hog-001';
const MEMBER_ID   = 'member-internal-001';
const HW_USER_ID  = 'kisi-user-99561846';
const MAPPING_ID  = 'mapping-abc';
const GROUP_ID    = '838622';
const EXISTING_RA = '93471315';

const mapping = {
  mappingId: MAPPING_ID,
  hardwareGroupId: GROUP_ID,
  hardwarePlatform: 'kisi',
  apiKey: 'plaintext-key',
};

const wixEvent = {
  eventType: 'plan.purchased',
  planId: 'plan-xyz',
  platformMemberId: 'wix-member-xyz',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[P1] processGrant idempotency on retry after prior partial success', () => {

  test('reuses existing role_assignment_id when member_role_assignments already has a row', async () => {
    // Simulate: prior attempt already wrote member_role_assignments + called Kisi.
    db.query.mockResolvedValueOnce({
      rows: [{ role_assignment_id: EXISTING_RA }],
    });
    // member_access_log INSERT at end of processGrant
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mapping], wixEvent);

    expect(hardwareAdapter.assignRole).not.toHaveBeenCalled(); // KEY: no re-call to Kisi
    expect(result).toEqual([
      {
        mappingId:        MAPPING_ID,
        roleAssignmentId: EXISTING_RA,
        hardwareGroupId:  GROUP_ID,
        sourcePlanId:     'plan-xyz',
        sourceType:       'plan',
      },
    ]);
  });

  test('calls assignRole normally when no prior row exists (fresh grant)', async () => {
    // No prior row
    db.query.mockResolvedValueOnce({ rows: [] });
    // Kisi returns fresh role_assignment
    hardwareAdapter.assignRole.mockResolvedValue('kisi-new-ra-77777777');
    // member_access_log INSERT at end
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mapping], wixEvent);

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(result[0].roleAssignmentId).toBe('kisi-new-ra-77777777');
  });

  test('prior row exists but role_assignment_id is NULL → treats as no-prior and calls assignRole', async () => {
    // Edge case: ghost row with NULL role_assignment_id (should be rare — UNIQUE constraint
    // plus NOT NULL column would normally prevent it, but defend against it).
    db.query.mockResolvedValueOnce({
      rows: [{ role_assignment_id: null }],
    });
    hardwareAdapter.assignRole.mockResolvedValue('kisi-fresh-ra-55555555');
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mapping], wixEvent);

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(result[0].roleAssignmentId).toBe('kisi-fresh-ra-55555555');
  });

  test('mixed — one mapping with prior assignment, one fresh', async () => {
    const mapping2 = { ...mapping, mappingId: 'mapping-second', hardwareGroupId: '999999' };
    // First mapping: prior row
    db.query.mockResolvedValueOnce({ rows: [{ role_assignment_id: EXISTING_RA }] });
    // Second mapping: no prior row
    db.query.mockResolvedValueOnce({ rows: [] });
    // Kisi assignRole for the fresh one
    hardwareAdapter.assignRole.mockResolvedValue('kisi-fresh-second');
    // member_access_log INSERT
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mapping, mapping2], wixEvent);

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1); // Only for the fresh one
    expect(result).toHaveLength(2);
    expect(result[0].roleAssignmentId).toBe(EXISTING_RA);
    expect(result[1].roleAssignmentId).toBe('kisi-fresh-second');
  });
});
