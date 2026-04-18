/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: Queue worker coordinates resolve → lock → provision flow     │
 * │                                                                         │
 * │  Business consequence: If the coordination between plan resolution,     │
 * │  identity locking, and hardware provisioning breaks, a paying member    │
 * │  either gets no access or gets the wrong access. Integration between    │
 * │  these steps is where production bugs hide.                             │
 * │                                                                         │
 * │  Critical path: job dequeued → resolve → lock → provision → complete    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('bullmq', () => ({
  Worker: jest.fn(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
}));

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({
  resolve: jest.fn(),
}));

jest.mock('../../adapters/standard-adapter', () => ({
  resolveAndLock:  jest.fn(),
  resolveIdentity: jest.fn(),
  completeGrant:   jest.fn(),
  completeRevoke:  jest.fn(),
  releaseLock:     jest.fn(),
}));

jest.mock('../../core/grant-revoke', () => ({
  processGrant: jest.fn(),
  processRevoke: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  enableAccess: jest.fn(),
}));

jest.mock('../../core/retry-engine', () => ({
  handleFailure: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `decrypted-${enc}`),
  encryptApiKey: jest.fn(),
}));

jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));

const db                = require('../../db');
const planMappingResolver = require('../../core/plan-mapping-resolver');
const standardAdapter   = require('../../adapters/standard-adapter');
const grantRevokeLogic  = require('../../core/grant-revoke');
const retryEngine       = require('../../core/retry-engine');
const hardwareAdapter   = require('../../adapters/hardware-adapter');
const { processJob }    = require('../../core/queue-worker');

const {
  HOG_CLIENT_ID,
  CONNECT_PLAN_ID,
  KISI_GROUP_ID,
  KISI_API_KEY_PLAINTEXT,
  KISI_HARDWARE_USER_ID,
  MEMBER_INTERNAL_ID,
  ENCRYPTED_API_KEY_DB_VALUE,
  planPurchasedEvent,
} = require('../helpers/fixtures');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJob(name, overrides = {}) {
  return {
    id:   'job-001',
    name,
    data: {
      tenantId:      HOG_CLIENT_ID,
      standardEvent: { ...planPurchasedEvent, ...overrides },
    },
    attemptsMade: 0,
    opts:         { attempts: 3 },
  };
}

const resolvedMappings = [
  {
    mappingId:        'plan-mapping-001',
    hardwareGroupId:  KISI_GROUP_ID,
    hardwarePlatform: 'kisi',
    tierName:         'Connect',
    accessType:       'group',
    apiKey:           KISI_API_KEY_PLAINTEXT,
  },
];

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default happy-path mocks
  planMappingResolver.resolve.mockResolvedValue(resolvedMappings);

  standardAdapter.resolveAndLock.mockResolvedValue({
    memberId: MEMBER_INTERNAL_ID,
    hardwareUserId: KISI_HARDWARE_USER_ID,
    hardwarePlatform: 'kisi',
  });

  standardAdapter.resolveIdentity.mockResolvedValue(KISI_HARDWARE_USER_ID);
  standardAdapter.completeGrant.mockResolvedValue();
  standardAdapter.releaseLock.mockResolvedValue();

  grantRevokeLogic.processGrant.mockResolvedValue([
    { mappingId: 'plan-mapping-001', roleAssignmentId: 'role-001', hardwareGroupId: KISI_GROUP_ID },
  ]);

  // Client API key lookup — returns encrypted key for decryption
  db.query.mockResolvedValue({ rows: [{ hardware_api_key: ENCRYPTED_API_KEY_DB_VALUE }] });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P1] Queue worker grant flow — resolve → lock → provision → complete', () => {

  it('resolves plan mappings, locks identity, provisions access, and completes — full happy path', async () => {
    const job = makeJob('grant');
    await processJob(job);

    // Step 1: resolver called with tenant + plan
    expect(planMappingResolver.resolve).toHaveBeenCalledWith(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    // Step 2: identity resolved and locked
    expect(standardAdapter.resolveAndLock).toHaveBeenCalledWith(
      HOG_CLIENT_ID, expect.objectContaining({ planId: CONNECT_PLAN_ID }), 'kisi'
    );

    // Step 3: hardware identity resolved
    // OB-89 Gate 2: queue-worker now passes { tenantId, platformMemberId } in opts so the
    // standard adapter can run the Wix Members API recovery ladder on missing-email errors.
    expect(standardAdapter.resolveIdentity).toHaveBeenCalledWith(
      MEMBER_INTERNAL_ID,
      planPurchasedEvent.email,
      planPurchasedEvent.name,
      'kisi',
      expect.any(String), // decrypted API key
      expect.objectContaining({
        tenantId: HOG_CLIENT_ID,
        platformMemberId: planPurchasedEvent.platformMemberId,
      })
    );

    // Step 4: grant executed
    expect(grantRevokeLogic.processGrant).toHaveBeenCalledWith(
      HOG_CLIENT_ID, MEMBER_INTERNAL_ID, KISI_HARDWARE_USER_ID,
      resolvedMappings, expect.objectContaining({ planId: CONNECT_PLAN_ID })
    );

    // Step 5: success recorded
    expect(standardAdapter.completeGrant).toHaveBeenCalledWith(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, expect.any(Array)
    );
  });

});

describe('[P1] Queue worker handles unknown plan — PLAN_NOT_MAPPED path (W-1)', () => {

  it('calls retryEngine.handleFailure when resolver returns null (unknown plan)', async () => {
    planMappingResolver.resolve.mockResolvedValue(null);

    const job = makeJob('grant', { planId: 'wix-plan-unknown-999' });
    await processJob(job);

    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
    const [failedJob, err] = retryEngine.handleFailure.mock.calls[0];
    expect(failedJob.id).toBe('job-001');
    expect(err.code).toBe('PLAN_NOT_MAPPED');
    expect(err.userMessage).toBeDefined();
    expect(err.action).toBeDefined();
  });

  it('does NOT call standardAdapter or grantRevokeLogic for unknown plans', async () => {
    planMappingResolver.resolve.mockResolvedValue(null);

    const job = makeJob('grant', { planId: 'wix-plan-unknown-999' });
    await processJob(job);

    expect(standardAdapter.resolveAndLock).not.toHaveBeenCalled();
    expect(grantRevokeLogic.processGrant).not.toHaveBeenCalled();
    expect(standardAdapter.completeGrant).not.toHaveBeenCalled();
  });

});

describe('[P1] Queue worker parks member when plan has no hardware group (Wix-first flow)', () => {

  it('parks member as pending_hardware when resolver returns empty array', async () => {
    planMappingResolver.resolve.mockResolvedValue([]);

    const job = makeJob('grant');
    await processJob(job);

    expect(standardAdapter.resolveAndLock).toHaveBeenCalled();
    expect(standardAdapter.releaseLock).toHaveBeenCalledWith(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, 'pending_hardware',
      expect.objectContaining({ planId: CONNECT_PLAN_ID })
    );
    expect(grantRevokeLogic.processGrant).not.toHaveBeenCalled();
  });

});

describe('[P1] Queue worker parks member when no API key is configured', () => {

  it('parks member as pending_hardware when client has no hardware API key', async () => {
    // Return no API key from client lookup
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: null }] });

    const job = makeJob('grant');
    await processJob(job);

    expect(standardAdapter.releaseLock).toHaveBeenCalledWith(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, 'pending_hardware',
      expect.objectContaining({ planId: CONNECT_PLAN_ID })
    );
    expect(grantRevokeLogic.processGrant).not.toHaveBeenCalled();
  });

});

describe('[P1] Queue worker releases lock and rethrows on hardware failure', () => {

  it('releases in_flight lock before rethrowing so member is not stuck', async () => {
    const kisiErr = new Error('Kisi 503');
    kisiErr.statusCode = 503;
    grantRevokeLogic.processGrant.mockRejectedValue(kisiErr);

    const job = makeJob('grant');
    await expect(processJob(job)).rejects.toThrow('Kisi 503');

    expect(standardAdapter.releaseLock).toHaveBeenCalledWith(
      MEMBER_INTERNAL_ID, HOG_CLIENT_ID, 'failed'
    );
  });

  it('throws UnrecoverableError for 4xx errors so BullMQ dead-letters immediately', async () => {
    const authErr = new Error('Kisi 401 Unauthorized');
    authErr.statusCode = 401;
    grantRevokeLogic.processGrant.mockRejectedValue(authErr);

    const job = makeJob('grant');
    await expect(processJob(job)).rejects.toThrow('Non-retryable');
  });

});
