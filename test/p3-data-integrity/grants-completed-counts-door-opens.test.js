/**
 * PRIORITY 3 — grants_completed counts doors opened, not jobs run.
 *
 * Wix fires 3-4 webhooks per purchase (orderUpdated ×2, orderPurchased ×1-2, orderStarted) and every
 * one becomes a grant job that reaches completeGrant. Only the first makes a door-system call; the
 * rest reuse its role assignment (grant-revoke.js marks those hardwareCallMade:false). The dashboard
 * showed 56 grants on a day with 30 real ones (2026-10-02) because each reuse still bumped the counter.
 *
 * Anything NOT marked (day pass, reconcile INSERT-missing, pending_start phase 2) keeps counting.
 */

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(), createUser: jest.fn(), assignRole: jest.fn(),
  removeRole: jest.fn(), suspendAccess: jest.fn(), enableAccess: jest.fn(), deleteUser: jest.fn(),
}));
jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: jest.fn(k => `enc:${k}`), decryptApiKey: jest.fn(e => e.replace('enc:', '')),
}));

const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');
const { HOG_CLIENT_ID, MEMBER_INTERNAL_ID, KISI_ROLE_ASSIGNMENT_ID, KISI_GROUP_ID } = require('../helpers/fixtures');

const base = {
  mappingId: 'pm-001', roleAssignmentId: KISI_ROLE_ASSIGNMENT_ID, hardwareGroupId: KISI_GROUP_ID,
  sourcePlanId: 'plan-xyz', sourceType: 'plan', wixOrderId: 'order-abc', cycleIndex: 1, planEndDate: null,
};

const activityInserts = () =>
  db.query.mock.calls.filter(c => /INSERT INTO client_activity_summary/.test(c[0]) && /grants_completed/.test(c[0]));

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  db.query.mockResolvedValueOnce({ rows: [{ member_master_id: 'mm-uuid-001' }] });   // _resolveMasterForGrant
});

describe('[P3] grants_completed is incremented only when a door-system call was made', () => {
  test('the job that called assignRole (hardwareCallMade: true) counts', async () => {
    await standardAdapter.completeGrant(MEMBER_INTERNAL_ID, HOG_CLIENT_ID, [{ ...base, hardwareCallMade: true }]);
    await flush();
    expect(activityInserts()).toHaveLength(1);
  });

  test('a duplicate-webhook job whose every assignment was reused (hardwareCallMade: false) does NOT count', async () => {
    await standardAdapter.completeGrant(MEMBER_INTERNAL_ID, HOG_CLIENT_ID, [
      { ...base, hardwareCallMade: false },
      { ...base, mappingId: 'pm-002', hardwareCallMade: false },
    ]);
    await flush();
    expect(activityInserts()).toHaveLength(0);
  });

  test('a mixed job (one new group, one reused) counts once', async () => {
    await standardAdapter.completeGrant(MEMBER_INTERNAL_ID, HOG_CLIENT_ID, [
      { ...base, hardwareCallMade: false },
      { ...base, mappingId: 'pm-002', hardwareGroupId: 'grp-2', hardwareCallMade: true },
    ]);
    await flush();
    expect(activityInserts()).toHaveLength(1);
  });

  test('callers that never set the flag (day pass, reconcile, pending_start) count exactly as before', async () => {
    await standardAdapter.completeGrant(MEMBER_INTERNAL_ID, HOG_CLIENT_ID, [{ ...base }]);
    await flush();
    expect(activityInserts()).toHaveLength(1);
  });
});
