/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                             │
 * │  adapters/standard-adapter.js — adapter.complete_grant.entry             │
 * │  cycleIndex / isRenewal                                                  │
 * │                                                                          │
 * │  2026-08-04: found that an operator scanning diagnostic_log for a        │
 * │  grant could not tell a first-time purchase from a recurring auto-       │
 * │  renewal without cross-referencing member_billing.cycle_index. Wix       │
 * │  already carries this on the order webhook (currentCycle.index, parsed   │
 * │  at wix-adapter.js) and it's threaded unchanged through grant-revoke.js  │
 * │  onto each assignment — it just was never logged.                       │
 * │                                                                          │
 * │  Sibling test for core/queue-worker.js's queue.grant.complete lives in   │
 * │  queue-grant-complete-cycle-index.test.js — kept in a separate file      │
 * │  because jest.mock() is file-scoped, not describe-scoped, and both       │
 * │  suites mock ../../core/logger and ../../db differently.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(), createUser: jest.fn(), assignRole: jest.fn(),
  removeRole: jest.fn(), suspendAccess: jest.fn(), enableAccess: jest.fn(), deleteUser: jest.fn(),
}));

const mockLogWarn = jest.fn();
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: mockLogWarn, error: jest.fn() },
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => null), setTraceContext: jest.fn(),
}));
jest.mock('../../adapters/wix/wix-members-api', () => ({ getMemberById: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k + '_decrypted') }));
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

const db      = require('../../db');
const adapter = require('../../adapters/standard-adapter');

const TENANT_ID        = 'client-uuid-cycle';
const MEMBER_ACCESS_ID = 'access-uuid-cycle';
const MEMBER_MASTER_ID = 'master-uuid-cycle';

function baseAssignment(cycleIndex) {
  return {
    mappingId: 'mapping-1', roleAssignmentId: 'ra-1', hardwareGroupId: 'hg-1',
    sourcePlanId: 'plan-1', sourceType: 'plan', planEndDate: null,
    wixOrderId: 'order-1', wixSubscriptionId: 'sub-1', cycleIndex,
    planId: 'plan-1', planName: 'Basic', effectiveStart: null, effectiveEnd: null,
    billingSnapshot: null, hardwarePlatform: 'kisi',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query
    .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // SELECT member_master_id
    .mockResolvedValueOnce({ rows: [{ id: 'billing-1', holder_seated: true }] }) // INSERT member_billing
    .mockResolvedValueOnce({ rows: [] })  // INSERT member_access_sources
    .mockResolvedValueOnce({ rows: [] })  // UPDATE member_access
    .mockResolvedValue({ rows: [] });     // activity + first-grant-email
});

describe('[P3] standard-adapter adapter.complete_grant.entry — cycleIndex / isRenewal', () => {
  test('cycleIndex=1 (first purchase) logs isRenewal=false', async () => {
    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment(1)]);
    const call = mockLogWarn.mock.calls.find(c => c[0] === 'adapter.complete_grant.entry');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: 1, isRenewal: false }));
  });

  test('cycleIndex=4 (recurring renewal) logs isRenewal=true', async () => {
    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment(4)]);
    const call = mockLogWarn.mock.calls.find(c => c[0] === 'adapter.complete_grant.entry');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: 4, isRenewal: true }));
  });

  test('cycleIndex null (e.g. booking-type grant) logs cycleIndex=null, isRenewal=null', async () => {
    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment(null)]);
    const call = mockLogWarn.mock.calls.find(c => c[0] === 'adapter.complete_grant.entry');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: null, isRenewal: null }));
  });
});
