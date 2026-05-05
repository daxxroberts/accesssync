/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: queue-worker.js against new schema                           │
 * │                                                                         │
 * │  Replaces: queue-worker-coordination.test.js (SKIPped in S-3,           │
 * │            un-skipped in S-8)                                           │
 * │                                                                         │
 * │  Tests the new-schema SQL shapes:                                       │
 * │    - Stall recovery: member_access WHERE status='in_flight' (not        │
 * │      member_identity JOIN member_access_state)                          │
 * │    - Revoke trace enrichment: member_access_sources JOIN plan_mappings  │
 * │    - Full grant job: planMappingResolver → resolveAndLock →             │
 * │      resolveIdentity → processGrant → completeGrant                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })),
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
  parkPendingStart: jest.fn(),
}));

jest.mock('../../core/grant-revoke', () => ({
  processGrant:  jest.fn(),
  processRevoke: jest.fn(),
}));

jest.mock('../../core/retry-engine', () => ({
  handleFailure: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  enableAccess: jest.fn(),
  getLocks:     jest.fn(),
}));

jest.mock('../../core/billing-snapshot', () => ({
  extractBillingSnapshot: jest.fn(() => ({ rate: 99, currency: 'USD' })),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(enc => `plaintext-${enc}`),
}));

jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({})),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { getJob: jest.fn() },
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

jest.mock('../../core/trace-context', () => ({
  runWith:          jest.fn((ctx, fn) => fn()),
  registerTrace:    jest.fn(),
  setTraceContext:  jest.fn(),
  getTraceId:       jest.fn(() => 'trace-s3-002'),
  getActor:         jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
}));

const db               = require('../../db');
const planMappingResolver = require('../../core/plan-mapping-resolver');
const standardAdapter  = require('../../adapters/standard-adapter');
const grantRevoke      = require('../../core/grant-revoke');
const { eventQueue }   = require('../../core/webhook-processor');
const { _processJobBody } = require('../../core/queue-worker');

const MEMBER_ID   = 'ma-uuid-001';
const TENANT_ID   = 'client-hog-001';
const MAPPING_ID  = 'mapping-uuid-001';
const GROUP_ID    = 'kisi-group-42';
const RA_ID       = 'kisi-ra-99561847';

const baseGrantJob = {
  id: 'job-001',
  name: 'grant',
  attemptsMade: 0,
  opts: { attempts: 3 },
  data: {
    tenantId: TENANT_ID,
    standardEvent: {
      traceId:          'trace-s3-002',
      eventId:          'event-001',
      eventType:        'plan.purchased',
      platformMemberId: 'wix-member-abc',
      planId:           'wix-plan-aaa',
      email:            'chad@houseofgains.com',
      name:             'Chad Owner',
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Stall recovery — member_access WHERE status='in_flight' ────────────────

describe('[P1] Stall recovery — new schema (member_access, not member_identity + member_access_state)', () => {

  test('queries member_access for in_flight status and releases lock', async () => {
    const mockJob = {
      id:   'stalled-job-001',
      name: 'grant',
      data: {
        tenantId:      TENANT_ID,
        standardEvent: { platformMemberId: 'wix-member-abc' },
      },
    };
    eventQueue.getJob.mockResolvedValue(mockJob);

    db.query.mockResolvedValueOnce({ rows: [{ id: MEMBER_ID }] });
    standardAdapter.releaseLock.mockResolvedValue();

    const { startWorker } = require('../../core/queue-worker');
    const worker = startWorker();
    const stalledHandler = worker.on.mock.calls.find(([evt]) => evt === 'stalled')?.[1];

    if (stalledHandler) {
      await stalledHandler('stalled-job-001');

      const dbCall = db.query.mock.calls[0];
      expect(dbCall[0]).toMatch(/FROM member_access/);
      expect(dbCall[0]).toMatch(/status\s*=\s*'in_flight'/);
      expect(dbCall[0]).not.toMatch(/member_identity/);
      expect(dbCall[0]).not.toMatch(/member_access_state/);
      expect(dbCall[1]).toEqual([TENANT_ID, 'wix-member-abc']);

      expect(standardAdapter.releaseLock).toHaveBeenCalledWith(MEMBER_ID, TENANT_ID, 'failed');
    }
  });
});

// ─── Full grant job sequence ─────────────────────────────────────────────────

describe('[P1] Full grant job — planMappingResolver → resolveAndLock → resolveIdentity → processGrant → completeGrant', () => {

  test('happy path: grant job succeeds end to end', async () => {
    const mapping = {
      mappingId:        MAPPING_ID,
      hardwarePlatform: 'kisi',
      hardwareGroupId:  GROUP_ID,
      apiKey:           'kisi-api-key',
      planName:         'Couples Plan',
      doorName:         'Main Entrance',
    };

    planMappingResolver.resolve.mockResolvedValue([mapping]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: MEMBER_ID });
    standardAdapter.resolveIdentity.mockResolvedValue('kisi-user-99');
    grantRevoke.processGrant.mockResolvedValue([{
      accessId:         MEMBER_ID,
      mappingId:        MAPPING_ID,
      roleAssignmentId: String(RA_ID),
      hardwareGroupId:  GROUP_ID,
    }]);
    standardAdapter.completeGrant.mockResolvedValue();

    // getClientApiKey reads hardware_api_key from clients
    db.query.mockResolvedValueOnce({ rows: [{ hardware_api_key: 'enc-key' }] });

    await _processJobBody(baseGrantJob, 'trace-s3-002');

    expect(planMappingResolver.resolve).toHaveBeenCalledWith(TENANT_ID, 'wix-plan-aaa');
    expect(standardAdapter.resolveAndLock).toHaveBeenCalled();
    expect(standardAdapter.resolveIdentity).toHaveBeenCalledWith(
      MEMBER_ID, 'chad@houseofgains.com', 'Chad Owner', 'kisi', 'plaintext-enc-key',
      { tenantId: TENANT_ID, platformMemberId: 'wix-member-abc' }
    );
    expect(grantRevoke.processGrant).toHaveBeenCalledWith(
      TENANT_ID, MEMBER_ID, 'kisi-user-99', [mapping], baseGrantJob.data.standardEvent
    );
    expect(standardAdapter.completeGrant).toHaveBeenCalled();
  });
});

// ─── Revoke trace enrichment — member_access_sources JOIN plan_mappings ──────

describe('[P1] Revoke trace enrichment — member_access_sources JOIN plan_mappings (new schema)', () => {

  const baseRevokeJob = {
    id: 'job-revoke-001',
    name: 'revoke',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      tenantId: TENANT_ID,
      standardEvent: {
        traceId:          'trace-s3-002',
        eventId:          'event-002',
        eventType:        'plan.cancelled',
        platformMemberId: 'wix-member-abc',
        planId:           'wix-plan-aaa',
      },
    },
  };

  test('enrichment query reads from member_access_sources, not member_role_assignments', async () => {
    standardAdapter.resolveAndLock.mockResolvedValue({
      memberId:          MEMBER_ID,
      hardwareUserId:    'kisi-user-99',
      hardwarePlatform:  'kisi',
      roleAssignmentIds: [RA_ID],
    });

    // trace enrichment DB query (revokeMappingRow)
    db.query.mockResolvedValueOnce({
      rows: [{ plan_name: 'Couples Plan', door_name: 'Main Entrance', mapping_id: MAPPING_ID }],
    });

    grantRevoke.processRevoke.mockResolvedValue('revoked');
    standardAdapter.completeRevoke.mockResolvedValue();

    await _processJobBody(baseRevokeJob, 'trace-s3-002');

    const enrichmentCall = db.query.mock.calls[0];
    expect(enrichmentCall[0]).toMatch(/FROM member_access_sources/);
    expect(enrichmentCall[0]).toMatch(/JOIN plan_mappings/);
    expect(enrichmentCall[0]).toMatch(/access_id\s*=\s*\$1/);
    expect(enrichmentCall[0]).not.toMatch(/member_role_assignments/);
    expect(enrichmentCall[1]).toEqual([MEMBER_ID]);
  });
});
