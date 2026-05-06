/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: OB-125 — source_tag guard on member.deleted → deleteUser     │
 * │                                                                         │
 * │  Business consequence: A `member.deleted` event for a member whose Kisi │
 * │  user is shared with an admin/staff identity (or any non-AccessSync     │
 * │  grant) would, without this guard, delete that Kisi user — killing      │
 * │  admin login and any non-AccessSync-granted role assignments.           │
 * │  Worst case: Daxx (Kisi org admin) buys a Wix plan, later the plan is   │
 * │  marked deleted in Wix, and the system nukes his admin account.         │
 * │                                                                         │
 * │  Policy (Daxx, 2026-04-29 / locked DR-003 spirit + DR-043):             │
 * │  AccessSync deletes only Kisi users it created (source_tag ===          │
 * │  'accesssync'). For foreign users, remove role assignments only,        │
 * │  leave the user.                                                        │
 * │                                                                         │
 * │  Critical path: member.deleted event → grant-revoke.processRevoke       │
 * │  reads source_tag from member_identity → calls deleteUser only when     │
 * │  source_tag === 'accesssync' → otherwise emits                          │
 * │  kisi.user.delete_skipped_foreign and proceeds with audit-only cleanup. │
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
const grantRevoke     = require('../../core/grant-revoke');

const {
  HOG_CLIENT_ID,
  MEMBER_INTERNAL_ID,
  KISI_HARDWARE_USER_ID,
  ENCRYPTED_API_KEY_DB_VALUE,
} = require('../helpers/fixtures');

const memberDeletedEvent = {
  eventType:        'member.deleted',
  platformMemberId: 'wix-member-foreign',
  sourcePlatform:   'wix',
};

// ─── Shared setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  hardwareAdapter.deleteUser.mockResolvedValue(null);
});

// Build a query mock that:
//   1. First call: _getClientApiKey → returns encrypted key
//   2. Second call: SELECT source_tag → returns the configured tag
//   3. All subsequent INSERTs (member_access_log, config_alert_log) succeed silently
function mockSourceTagLookup(sourceTag) {
  db.query
    .mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] })  // _getClientApiKey
    .mockResolvedValueOnce({ rows: [{ source_tag: sourceTag }] })                          // SELECT source_tag
    .mockResolvedValue({ rows: [] });                                                      // INSERTs
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P1] OB-125 source_tag guard on member.deleted → deleteUser', () => {

  it('CALLS deleteUser when source_tag is accesssync — AccessSync owns this Kisi user', async () => {
    mockSourceTagLookup('accesssync');

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [],
      'kisi',
      'member.deleted',
      memberDeletedEvent
    );

    expect(hardwareAdapter.deleteUser).toHaveBeenCalledTimes(1);
    // The mock decrypt strips 'enc:' prefix; the test fixture has no prefix so
    // the decrypted value equals the encrypted value (intentional in fixtures.js).
    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith('kisi', ENCRYPTED_API_KEY_DB_VALUE, KISI_HARDWARE_USER_ID);
    expect(targetStatus).toBe('deleted');
  });

  it('SKIPS deleteUser when source_tag is something else — Kisi user not owned by AccessSync', async () => {
    mockSourceTagLookup('manual');

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [],
      'kisi',
      'member.deleted',
      memberDeletedEvent
    );

    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    // Audit cleanup still proceeds — operator sees the member.deleted event in the log
    expect(targetStatus).toBe('deleted');
  });

  it('SKIPS deleteUser when source_tag is NULL — defensive default for legacy rows', async () => {
    mockSourceTagLookup(null);

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [],
      'kisi',
      'member.deleted',
      memberDeletedEvent
    );

    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    expect(targetStatus).toBe('deleted');
  });

  it('does NOT call deleteUser at all when hardware_user_id is null — no Kisi presence to delete', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] })
      .mockResolvedValue({ rows: [] });

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      null,                  // no hardware_user_id
      [],
      'kisi',
      'member.deleted',
      memberDeletedEvent
    );

    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    expect(targetStatus).toBe('deleted');
  });
});
