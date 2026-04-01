/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: Member purchases Wix plan → access provisioned in hardware   │
 * │                                                                         │
 * │  Business consequence: If this fails, a paying member cannot enter the  │
 * │  gym on their first visit. This is the highest severity bug regardless  │
 * │  of how rarely it occurs.                                               │
 * │                                                                         │
 * │  Critical path: payment → webhook → provisioning → door opens           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// Manual mock factories — db.js calls process.exit(1) at load time when DATABASE_URL
// is unset, so we must provide a factory to prevent the real file from executing.
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

const db             = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke    = require('../../core/grant-revoke');

const {
  HOG_CLIENT_ID,
  MEMBER_INTERNAL_ID,
  KISI_HARDWARE_USER_ID,
  KISI_ROLE_ASSIGNMENT_ID,
  KISI_GROUP_ID,
  KISI_API_KEY_PLAINTEXT,
  activeMappings,
  activeMappingsMultiDoor,
  planPurchasedEvent,
} = require('../helpers/fixtures');

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default mock: assignRole returns a role assignment ID
  hardwareAdapter.assignRole.mockResolvedValue(KISI_ROLE_ASSIGNMENT_ID);
  // Default mock: DB insert succeeds
  db.query.mockResolvedValue({ rows: [] });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P1] Member purchases Wix plan → access provisioned in hardware', () => {

  it('calls hardware adapter to assign door access for the correct group', async () => {
    await grantRevoke.processGrant(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      activeMappings,
      planPurchasedEvent
    );

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith(
      'kisi',
      KISI_API_KEY_PLAINTEXT,
      KISI_HARDWARE_USER_ID,
      KISI_GROUP_ID
    );
  });

  it('returns role assignment IDs so the system can revoke access later', async () => {
    const assignments = await grantRevoke.processGrant(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      activeMappings,
      planPurchasedEvent
    );

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      mappingId:        activeMappings[0].mappingId,
      roleAssignmentId: String(KISI_ROLE_ASSIGNMENT_ID),
    });
  });

  it('writes a provisioned event to the audit log so operators can see access was granted', async () => {
    await grantRevoke.processGrant(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      activeMappings,
      planPurchasedEvent
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('member_access_log'),
      expect.arrayContaining([MEMBER_INTERNAL_ID, HOG_CLIENT_ID])
    );
  });

});

describe('[P1] Member with multi-door plan gets access to all mapped doors', () => {

  it('assigns access to every door in the plan mapping — not just the first', async () => {
    await grantRevoke.processGrant(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      activeMappingsMultiDoor,
      planPurchasedEvent
    );

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, KISI_HARDWARE_USER_ID, 'kisi-group-front-door'
    );
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, KISI_HARDWARE_USER_ID, 'kisi-group-gym-floor'
    );
  });

  it('returns one assignment record per door so all can be revoked individually', async () => {
    hardwareAdapter.assignRole
      .mockResolvedValueOnce('role-front-door-001')
      .mockResolvedValueOnce('role-gym-floor-001');

    const assignments = await grantRevoke.processGrant(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      activeMappingsMultiDoor,
      planPurchasedEvent
    );

    expect(assignments).toHaveLength(2);
    expect(assignments.map(a => a.roleAssignmentId)).toEqual(
      expect.arrayContaining(['role-front-door-001', 'role-gym-floor-001'])
    );
  });

});

describe('[P1] Hardware failure during provisioning is surfaced — not silently swallowed', () => {

  it('throws when Kisi returns an error so the job queue can retry or dead-letter', async () => {
    const kisiError = new Error('Kisi API Error: 401 Unauthorized');
    kisiError.statusCode = 401;
    hardwareAdapter.assignRole.mockRejectedValue(kisiError);

    await expect(
      grantRevoke.processGrant(
        HOG_CLIENT_ID,
        MEMBER_INTERNAL_ID,
        KISI_HARDWARE_USER_ID,
        activeMappings,
        planPurchasedEvent
      )
    ).rejects.toThrow('401 Unauthorized');
  });

  it('does NOT write a provisioned audit log entry when the hardware call fails', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(new Error('Kisi API Error: 503'));

    try {
      await grantRevoke.processGrant(
        HOG_CLIENT_ID,
        MEMBER_INTERNAL_ID,
        KISI_HARDWARE_USER_ID,
        activeMappings,
        planPurchasedEvent
      );
    } catch (_) { /* expected */ }

    // The member_access_log INSERT should NOT have been reached
    const logInsertCalled = db.query.mock.calls.some(
      call => call[0] && call[0].includes('member_access_log')
    );
    expect(logInsertCalled).toBe(false);
  });

});
