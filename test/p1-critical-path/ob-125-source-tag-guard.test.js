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
 * │  Critical path (since the 2026-10-26 fix): member.deleted →             │
 * │  grant-revoke.processRevoke removes every door AccessSync granted, for  │
 * │  ANY member, and never deletes the Kisi user itself → queue-worker runs │
 * │  standard-adapter.finalizeRevoke, whose Layer A check deletes the user  │
 * │  only when source_tag === 'accesssync' (foreign_source_tag otherwise). │
 * │  Before the fix processRevoke called deleteUser with no removeRole: a   │
 * │  foreign user kept their AccessSync doors, and a DR-045 refusal turned  │
 * │  into a retry loop that left the door open.                             │
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
  deleteGroupLink: jest.fn(),
  getRoleAssignmentsForUser: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: jest.fn(key => `enc:${key}`),
  decryptApiKey: jest.fn(enc => enc.replace('enc:', '')),
}));

jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');
const standardAdapter = require('../../adapters/standard-adapter');

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
  db.query.mockReset();
  hardwareAdapter.removeRole.mockResolvedValue(null);
  hardwareAdapter.deleteGroupLink.mockResolvedValue(null);
  hardwareAdapter.deleteUser.mockResolvedValue(null);
});

// processRevoke's queries: _getClientApiKey, then the granted-doors SELECT, then
// the audit INSERTs (member_access_log, config_alert_log).
function mockGrantedDoors(rows) {
  db.query
    .mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] })  // _getClientApiKey
    .mockResolvedValueOnce({ rows })                                                       // granted doors
    .mockResolvedValue({ rows: [] });                                                      // INSERTs
}

const memberDeleted = (hardwareUserId = KISI_HARDWARE_USER_ID) => grantRevoke.processRevoke(
  HOG_CLIENT_ID, MEMBER_INTERNAL_ID, hardwareUserId, [], 'kisi', 'member.deleted', memberDeletedEvent
);

// ─── processRevoke: take the doors away, leave the user to finalize ─────────

describe('[P1] OB-125 member.deleted — processRevoke removes the doors, never the Kisi user', () => {

  it('removes every role assignment and day-pass link AccessSync granted', async () => {
    mockGrantedDoors([
      { role_assignment_id: 'ra-front', source_type: 'plan' },
      { role_assignment_id: 'ra-yoga',  source_type: 'booking' },
      { role_assignment_id: 'link-9',   source_type: 'day_pass' },
    ]);

    const targetStatus = await memberDeleted();

    expect(hardwareAdapter.removeRole).toHaveBeenCalledTimes(2);
    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith('kisi', ENCRYPTED_API_KEY_DB_VALUE, 'ra-front');
    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith('kisi', ENCRYPTED_API_KEY_DB_VALUE, 'ra-yoga');
    expect(hardwareAdapter.deleteGroupLink).toHaveBeenCalledWith(
      'kisi', ENCRYPTED_API_KEY_DB_VALUE, 'link-9', { clientId: HOG_CLIENT_ID });
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();   // finalizeRevoke's job now
    expect(targetStatus).toBe('deleted');                         // queue-worker finalizes on 'deleted'

    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/FROM member_access_sources/);
    expect(sql).toMatch(/access_id = \$1/);
    expect(sql).toMatch(/role_assignment_id IS NOT NULL/);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/);       // the rows are completeRevoke's to clear
    expect(params).toEqual([MEMBER_INTERNAL_ID]);
  });

  it('removes the doors BEFORE writing the audit rows — a Kisi timeout throws (retryable) with nothing logged yet', async () => {
    mockGrantedDoors([{ role_assignment_id: 'ra-front', source_type: 'plan' }]);
    hardwareAdapter.removeRole.mockRejectedValueOnce(Object.assign(new Error('Kisi 503'), { statusCode: 503 }));

    await expect(memberDeleted()).rejects.toThrow('Kisi 503');

    const writes = db.query.mock.calls.filter(c => /INSERT INTO/.test(c[0]));
    expect(writes).toHaveLength(0);
  });

  it('a foreign member (any source_tag) still loses the doors AccessSync gave them — the policy\'s "remove role assignments only"', async () => {
    mockGrantedDoors([{ role_assignment_id: 'ra-front', source_type: 'plan' }]);

    await memberDeleted();

    // processRevoke no longer reads source_tag at all: removing AccessSync's own grants is right for everyone.
    expect(db.query.mock.calls.some(c => /source_tag/.test(c[0]))).toBe(false);
    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith('kisi', ENCRYPTED_API_KEY_DB_VALUE, 'ra-front');
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
  });

  it('nothing granted and no Kisi user → no Kisi calls; the audit rows are still written', async () => {
    mockGrantedDoors([]);

    const targetStatus = await memberDeleted(null);

    expect(hardwareAdapter.removeRole).not.toHaveBeenCalled();
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(c => /INSERT INTO config_alert_log/.test(c[0]))).toBe(true);
    expect(targetStatus).toBe('deleted');
  });
});

// ─── finalizeRevoke: Layer A decides whether the user may be deleted ───────

describe('[P1] OB-125 member.deleted — finalizeRevoke deletes the Kisi user only when AccessSync created it', () => {

  function accessRow(sourceTag) {
    return { rows: [{ status: 'inactive', hardware_user_id: KISI_HARDWARE_USER_ID,
      member_master_id: 'master-1', source_tag: sourceTag }] };
  }

  it.each([['manual'], [null]])('source_tag %s → refused (foreign_source_tag): no deleteUser, no purge', async (tag) => {
    db.query.mockResolvedValueOnce(accessRow(tag));

    const result = await standardAdapter.finalizeRevoke(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, 'kisi', 'key', KISI_HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'foreign_source_tag' });
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    expect(db.getClient).not.toHaveBeenCalled();   // PII purge transaction never opened
  });

  it('source_tag accesssync → the user is deleted (through the DR-045 Kisi guards) and PII purged', async () => {
    db.query
      .mockResolvedValueOnce(accessRow('accesssync'))
      .mockResolvedValueOnce({ rows: [] });          // Guard E: nobody shares the user
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([]);   // Guard D: our doors are gone
    db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });

    const result = await standardAdapter.finalizeRevoke(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, 'kisi', 'key', KISI_HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: true, reason: 'ok' });
    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith('kisi', 'key', KISI_HARDWARE_USER_ID, { clientId: HOG_CLIENT_ID });
  });
});
