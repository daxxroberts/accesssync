/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a paying member's plan resolves to no door                   │
 * │  (owner hub review 2026-10-15, bug 3)                                   │
 * │                                                                         │
 * │  Business consequence: when a location's subscription lapsed or a door  │
 * │  group was deleted in Kisi, the member was parked with an info log and  │
 * │  nothing else — no error row, no email, nothing on the owner hub. Only  │
 * │  "no group chosen yet" (Wix-first setup) is a quiet park.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                          () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter',   () => ({
  resolveAndLock: jest.fn(), resolveIdentity: jest.fn(), completeGrant: jest.fn(), completeRevoke: jest.fn(),
  releaseLock: jest.fn(), parkPendingStart: jest.fn(), parkPendingHardware: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter',   () => ({ assignRole: jest.fn(), enableAccess: jest.fn() }));
jest.mock('../../core/grant-revoke',           () => ({ processGrant: jest.fn(), processRevoke: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver',  () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',           () => ({ handleFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/redis-utils',            () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',      () => ({ eventQueue: { getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',           () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error { constructor(msg) { super(msg); this.name = 'UnrecoverableError'; } },
  Queue: jest.fn(),
}));

const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');
const mappingResolver = require('../../core/plan-mapping-resolver');
const retryEngine     = require('../../core/retry-engine');
const { processJob, startWorker } = require('../../core/queue-worker');
const { mintTraceId } = require('../../core/trace-context');

const makeJob = () => ({
  id: 'job-no-door', name: 'grant', attemptsMade: 1, opts: { attempts: 3 },
  data: { tenantId: 'tenant-001', standardEvent: { traceId: mintTraceId(), eventId: 'evt-1', eventType: 'plan.purchased', platformMemberId: 'wix-m-1', planId: 'plan-1' } },
});

function emptyWithReason(reason) {
  const empty = [];
  Object.defineProperty(empty, 'noMappingReason', { value: reason, enumerable: false });
  return empty;
}

beforeAll(() => { startWorker(); });
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: null, hardwarePlatform: 'kisi' });
});

describe('[P1] a paying member with no door reaches the error list', () => {
  test('location lapsed → parked AND dead-lettered as SUBSCRIPTION_LAPSED (AccessSync must act)', async () => {
    mappingResolver.resolve.mockResolvedValue(emptyWithReason('location_lapsed'));
    await processJob(makeJob());
    expect(standardAdapter.parkPendingHardware).toHaveBeenCalledWith('m-001', 'tenant-001', []);
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
    const [job, err] = retryEngine.handleFailure.mock.calls[0];
    expect(job.id).toBe('job-no-door');
    expect(err.code).toBe('SUBSCRIPTION_LAPSED');
    expect(err.userMessage).toMatch(/subscription is not active/);
  });

  test('every door group gone from Kisi → dead-lettered as HARDWARE_RESOURCE_NOT_FOUND with REMAP_PLAN (the gym must act)', async () => {
    mappingResolver.resolve.mockResolvedValue(emptyWithReason('group_unhealthy'));
    await processJob(makeJob());
    const [, err] = retryEngine.handleFailure.mock.calls[0];
    expect(err).toMatchObject({ code: 'HARDWARE_RESOURCE_NOT_FOUND', resolution: 'REMAP_PLAN' });
    expect(err.action).toMatch(/Plan Mapping/);
  });

  test('no door group chosen yet (Wix-first setup) → quiet park, no error row', async () => {
    mappingResolver.resolve.mockResolvedValue(emptyWithReason('no_group'));
    await processJob(makeJob());
    expect(standardAdapter.parkPendingHardware).toHaveBeenCalledWith('m-001', 'tenant-001', []);
    expect(retryEngine.handleFailure).not.toHaveBeenCalled();
  });

  test('a plain empty array (older resolver, no reason) is still a quiet park', async () => {
    mappingResolver.resolve.mockResolvedValue([]);
    await processJob(makeJob());
    expect(retryEngine.handleFailure).not.toHaveBeenCalled();
  });
});
