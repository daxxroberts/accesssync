/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                             │
 * │  core/queue-worker.js — queue.grant.complete cycleIndex / isRenewal      │
 * │                                                                          │
 * │  2026-08-04: found that an operator scanning diagnostic_log for a        │
 * │  grant could not tell a first-time purchase from a recurring auto-       │
 * │  renewal without cross-referencing member_billing.cycle_index. Wix       │
 * │  already carries this on the order webhook (currentCycle.index, parsed   │
 * │  at wix-adapter.js) and it's threaded unchanged through grant-revoke.js  │
 * │  into standardEvent.cycleIndex — it just was never logged.               │
 * │                                                                          │
 * │  Sibling test for adapters/standard-adapter.js's adapter.complete_grant. │
 * │  entry lives in its own file (grant-log-cycle-index.test.js needed to    │
 * │  be split — jest.mock() is file-scoped, not describe-scoped, so two      │
 * │  blocks mocking the same module paths differently in one file silently   │
 * │  collide).                                                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })),
  Worker: jest.fn(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
}));

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../adapters/standard-adapter', () => ({
  resolveAndLock:       jest.fn(),
  resolveIdentity:      jest.fn(),
  completeGrant:        jest.fn(),
  completeRevoke:       jest.fn(),
  releaseLock:          jest.fn(),
  parkPendingStart:     jest.fn(),
  parkPendingHardware:  jest.fn(),
}));
jest.mock('../../core/grant-revoke', () => ({ processGrant: jest.fn(), processRevoke: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({ enableAccess: jest.fn() }));
jest.mock('../../core/retry-engine', () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `decrypted-${enc}`),
  encryptApiKey: jest.fn(),
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));

const mockLoggerInfo = jest.fn();
jest.mock('../../core/logger', () => ({
  log:       { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({
    debug: jest.fn(), info: mockLoggerInfo, warn: jest.fn(), error: jest.fn(), critical: jest.fn(),
  })),
}));

const db                  = require('../../db');
const planMappingResolver = require('../../core/plan-mapping-resolver');
const standardAdapter     = require('../../adapters/standard-adapter');
const grantRevokeLogic    = require('../../core/grant-revoke');
const { processJob }      = require('../../core/queue-worker');

const {
  HOG_CLIENT_ID, CONNECT_PLAN_ID, KISI_GROUP_ID, KISI_HARDWARE_USER_ID,
  MEMBER_INTERNAL_ID, ENCRYPTED_API_KEY_DB_VALUE, planPurchasedEvent,
} = require('../helpers/fixtures');

function makeJob(overrides = {}) {
  return {
    id: 'job-cycle-001', name: 'grant',
    data: { tenantId: HOG_CLIENT_ID, standardEvent: { ...planPurchasedEvent, ...overrides } },
    attemptsMade: 0, opts: { attempts: 3 },
  };
}

const resolvedMappings = [{
  mappingId: 'plan-mapping-001', hardwareGroupId: KISI_GROUP_ID,
  hardwarePlatform: 'kisi', tierName: 'Connect', accessType: 'group',
  apiKey: 'plaintext-key',
}];

beforeEach(() => {
  jest.clearAllMocks();
  planMappingResolver.resolve.mockResolvedValue(resolvedMappings);
  standardAdapter.resolveAndLock.mockResolvedValue({
    memberId: MEMBER_INTERNAL_ID, hardwareUserId: KISI_HARDWARE_USER_ID, hardwarePlatform: 'kisi',
  });
  standardAdapter.resolveIdentity.mockResolvedValue(KISI_HARDWARE_USER_ID);
  standardAdapter.completeGrant.mockResolvedValue();
  standardAdapter.releaseLock.mockResolvedValue();
  grantRevokeLogic.processGrant.mockResolvedValue([
    { mappingId: 'plan-mapping-001', roleAssignmentId: 'role-001', hardwareGroupId: KISI_GROUP_ID },
  ]);
  db.query.mockResolvedValue({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] });
});

describe('[P3] queue-worker queue.grant.complete — cycleIndex / isRenewal', () => {
  test('cycleIndex=1 (first purchase) logs isRenewal=false', async () => {
    await processJob(makeJob({ cycleIndex: 1 }));
    const call = mockLoggerInfo.mock.calls.find(c => c[0] === 'queue.grant.complete');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: 1, isRenewal: false }));
  });

  test('cycleIndex=4 (recurring renewal) logs isRenewal=true', async () => {
    await processJob(makeJob({ cycleIndex: 4 }));
    const call = mockLoggerInfo.mock.calls.find(c => c[0] === 'queue.grant.complete');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: 4, isRenewal: true }));
  });

  test('cycleIndex absent (e.g. booking-type grant) logs cycleIndex=null, isRenewal=null — not a false "new"', async () => {
    const overrides = { ...planPurchasedEvent };
    delete overrides.cycleIndex;
    await processJob(makeJob(overrides));
    const call = mockLoggerInfo.mock.calls.find(c => c[0] === 'queue.grant.complete');
    expect(call[1]).toEqual(expect.objectContaining({ cycleIndex: null, isRenewal: null }));
  });
});
