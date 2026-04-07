/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: Member cancels or payment fails → access revoked correctly   │
 * │                                                                         │
 * │  Business consequence: If revoke fails silently, a former member        │
 * │  retains door access after cancelling. Security liability.              │
 * │  If suspend fails, a member with failed payment retains access.         │
 * │  Operators are liable for unauthorised facility entry.                  │
 * │                                                                         │
 * │  Critical path: cancel/payment-failure → revoke webhook → hardware      │
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
const hardwareAdapter  = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const {
  HOG_CLIENT_ID,
  MEMBER_INTERNAL_ID,
  KISI_HARDWARE_USER_ID,
  KISI_ROLE_ASSIGNMENT_ID,
  KISI_API_KEY_PLAINTEXT,
  ENCRYPTED_API_KEY_DB_VALUE,
  planCancelledEvent,
  paymentFailedEvent,
  paymentRecoveredEvent,
} = require('../helpers/fixtures');

// ─── Shared setup ───────────────────────────────────────────────────────────

function mockClientApiKey() {
  // The first db.query call in processRevoke is _getClientApiKey → SELECT hardware_api_key
  db.query.mockResolvedValueOnce({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] });
  // Subsequent calls (INSERT INTO member_access_log, etc.) succeed silently
  db.query.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  hardwareAdapter.removeRole.mockResolvedValue(null);
  hardwareAdapter.suspendAccess.mockResolvedValue(null);
  hardwareAdapter.enableAccess.mockResolvedValue(null);
  hardwareAdapter.deleteUser.mockResolvedValue(null);
  mockClientApiKey();
});

// ─── Plan Cancellation ───────────────────────────────────────────────────────

describe('[P1] Member cancels plan → all door access revoked', () => {

  it('removes every role assignment when plan is cancelled — member cannot re-enter', async () => {
    const roleIds = [KISI_ROLE_ASSIGNMENT_ID, 'role-assignment-gym-floor'];

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      roleIds,
      'kisi',
      'plan.cancelled',
      planCancelledEvent
    );

    expect(hardwareAdapter.removeRole).toHaveBeenCalledTimes(2);
    expect(targetStatus).toBe('revoked');
  });

  it('uses the decrypted API key from DB — never a hardcoded or mock key', async () => {
    await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [KISI_ROLE_ASSIGNMENT_ID],
      'kisi',
      'plan.cancelled',
      planCancelledEvent
    );

    // The key passed to removeRole should be the decrypted value (mock strips 'enc:')
    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith(
      'kisi',
      ENCRYPTED_API_KEY_DB_VALUE.replace('enc:', ''),
      KISI_ROLE_ASSIGNMENT_ID
    );
  });

  it('writes a revoked audit log entry so the operator can see when access ended', async () => {
    await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [KISI_ROLE_ASSIGNMENT_ID],
      'kisi',
      'plan.cancelled',
      planCancelledEvent
    );

    const logCall = db.query.mock.calls.find(
      c => c[0] && c[0].includes('member_access_log')
    );
    expect(logCall).toBeDefined();
    expect(logCall[1]).toContain(MEMBER_INTERNAL_ID);
  });

});

// ─── Payment Failure (Suspend, not Delete) ───────────────────────────────────

describe('[P1] Payment fails → access suspended (roles preserved for recovery)', () => {

  it('suspends the user account rather than deleting roles — enabling fast re-activation', async () => {
    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [KISI_ROLE_ASSIGNMENT_ID],
      'kisi',
      'payment.failed',
      paymentFailedEvent
    );

    expect(hardwareAdapter.suspendAccess).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.removeRole).not.toHaveBeenCalled(); // Roles preserved
    expect(targetStatus).toBe('disabled');
  });

});

// ─── Member Deleted (Hard Delete) ────────────────────────────────────────────

describe('[P1] Deleted member → hardware user removed from org', () => {

  it('deletes the user from hardware so they are completely removed from the org', async () => {
    const deletedEvent = { ...planCancelledEvent, eventType: 'member.deleted' };

    const targetStatus = await grantRevoke.processRevoke(
      HOG_CLIENT_ID,
      MEMBER_INTERNAL_ID,
      KISI_HARDWARE_USER_ID,
      [],
      'kisi',
      'member.deleted',
      deletedEvent
    );

    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith(
      'kisi',
      expect.any(String),
      KISI_HARDWARE_USER_ID
    );
    expect(targetStatus).toBe('deleted');
  });

});
