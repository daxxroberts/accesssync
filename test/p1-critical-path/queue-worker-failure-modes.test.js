/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: queue-worker failure modes and error escalation paths        │
 * │                                                                         │
 * │  Business consequence: Silent failures mean a paying member never gets  │
 * │  access and no operator alert fires. Every failure mode must produce    │
 * │  the correct error escalation, log event, and BullMQ throw behaviour.  │
 * │                                                                         │
 * │  Governed by: DR-026 (UnrecoverableError), DR-037 (traceId required)   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                          () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter',   () => ({
  resolveAndLock:       jest.fn(),
  resolveIdentity:      jest.fn(),
  completeGrant:        jest.fn(),
  completeRevoke:       jest.fn(),
  releaseLock:          jest.fn(),
  parkPendingStart:     jest.fn(),
  parkPendingHardware:  jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter',   () => ({
  assignRole:     jest.fn(),
  enableAccess:   jest.fn(),
}));
jest.mock('../../core/grant-revoke',           () => ({
  processGrant:  jest.fn(),
  processRevoke: jest.fn(),
}));
jest.mock('../../core/plan-mapping-resolver',  () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',           () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/redis-utils',            () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',      () => ({ eventQueue: { getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',           () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
  Queue: jest.fn(),
}));

const db               = require('../../db');
const standardAdapter  = require('../../adapters/standard-adapter');
const grantRevoke      = require('../../core/grant-revoke');
const mappingResolver  = require('../../core/plan-mapping-resolver');
const retryEngine      = require('../../core/retry-engine');
const { processJob }   = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const { UnrecoverableError } = require('bullmq');

let stdoutLines = [];
let originalWrite;

beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      try { stdoutLines.push(JSON.parse(chunk.trim())); } catch {}
    }
    return true;
  };
});

afterAll(() => { process.stdout.write = originalWrite; });

beforeEach(() => {
  stdoutLines = [];
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

function makeJob(overrides = {}, eventOverrides = {}) {
  return {
    id: 'job-fail-001',
    name: 'grant',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      tenantId: 'tenant-001',
      standardEvent: {
        traceId: mintTraceId(),
        eventId: 'evt-001',
        eventType: 'plan.purchased',
        platformMemberId: 'wix-member-abc',
        planId: 'plan-xyz',
        email: null,
        name: null,
        ...eventOverrides,
      },
    },
    ...overrides,
  };
}

// ── traceId enforcement ───────────────────────────────────────────────────────

describe('[P1] queue-worker: traceId enforcement', () => {

  test('throws QUEUE_JOB_MISSING_TRACE_ID when traceId is empty string', async () => {
    const job = makeJob({}, { traceId: '' });
    await expect(processJob(job)).rejects.toThrow('QUEUE_JOB_MISSING_TRACE_ID');
  });

  test('throws QUEUE_JOB_MISSING_TRACE_ID when job.data is undefined', async () => {
    const job = { id: 'j1', name: 'grant', attemptsMade: 0, opts: { attempts: 3 }, data: undefined };
    await expect(processJob(job)).rejects.toThrow('QUEUE_JOB_MISSING_TRACE_ID');
  });

  test('logs queue.job.missing_trace_id error event before throwing', async () => {
    const job = makeJob();
    delete job.data.standardEvent.traceId;
    await expect(processJob(job)).rejects.toThrow();
    const errLog = stdoutLines.find(l => l.event === 'queue.job.missing_trace_id');
    expect(errLog).toBeDefined();
    expect(errLog.level).toBe('error');
  });

});

// ── 4xx errors → UnrecoverableError ──────────────────────────────────────────

describe('[P1] queue-worker: 4xx errors escalate to UnrecoverableError (DR-026)', () => {

  test('401 from hardware adapter throws UnrecoverableError', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    grantRevoke.processGrant.mockRejectedValue(err);

    await expect(processJob(job)).rejects.toThrow('Non-retryable hardware error (401)');
    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  test('403 from hardware adapter throws UnrecoverableError', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    const err = new Error('Forbidden');
    err.statusCode = 403;
    grantRevoke.processGrant.mockRejectedValue(err);

    await expect(processJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  test('429 is retryable — does NOT throw UnrecoverableError', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    const err = new Error('Rate limited');
    err.statusCode = 429;
    grantRevoke.processGrant.mockRejectedValue(err);

    try {
      await processJob(job);
    } catch (e) {
      expect(e.name).not.toBe('UnrecoverableError');
    }
  });

  test('500 server error is retryable — does NOT throw UnrecoverableError', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    const err = new Error('Internal server error');
    err.statusCode = 500;
    grantRevoke.processGrant.mockRejectedValue(err);

    try {
      await processJob(job);
    } catch (e) {
      expect(e.name).not.toBe('UnrecoverableError');
    }
  });

  test('error without statusCode is retryable', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    grantRevoke.processGrant.mockRejectedValue(new Error('Connection reset'));

    try {
      await processJob(job);
    } catch (e) {
      expect(e.name).not.toBe('UnrecoverableError');
    }
  });

});

// ── releaseLock on failure ────────────────────────────────────────────────────

describe('[P1] queue-worker: releaseLock is called on job failure', () => {

  test('releaseLock is called with memberId when grant step fails post-lock', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    grantRevoke.processGrant.mockRejectedValue(new Error('hardware down'));

    await expect(processJob(job)).rejects.toThrow();
    expect(standardAdapter.releaseLock).toHaveBeenCalledWith('m-001', 'tenant-001', 'failed');
  });

  test('queue.job.failed log event is emitted on catch', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    grantRevoke.processGrant.mockRejectedValue(new Error('hardware down'));

    await expect(processJob(job)).rejects.toThrow();
    const failLog = stdoutLines.find(l => l.event === 'queue.job.failed');
    expect(failLog).toBeDefined();
    expect(failLog.level).toBe('error');
  });

  test('queue.job.failed log carries lastStep field', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    grantRevoke.processGrant.mockRejectedValue(new Error('hardware down'));

    await expect(processJob(job)).rejects.toThrow();
    const failLog = stdoutLines.find(l => l.event === 'queue.job.failed');
    expect(failLog.lastStep).toBeDefined();
    expect(typeof failLog.lastStep).toBe('string');
  });

});

// ── Early-exit paths ──────────────────────────────────────────────────────────

describe('[P1] queue-worker: early-exit paths do not throw', () => {

  test('plan.not_mapped path calls retryEngine.handleFailure and returns', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue(null);
    retryEngine.handleFailure.mockResolvedValue();

    await expect(processJob(job)).resolves.toBeUndefined();
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
  });

  test('plan.not_mapped error passed to retryEngine has code PLAN_NOT_MAPPED', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue(null);
    retryEngine.handleFailure.mockResolvedValue();

    await processJob(job);
    const [, err] = retryEngine.handleFailure.mock.calls[0];
    expect(err.code).toBe('PLAN_NOT_MAPPED');
  });

  test('no-api-key path parks member and returns without throwing', async () => {
    const job = makeJob();
    const mappings = [{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', sourcePlanId: 'p-1', apiKey: 'key' }];
    mappingResolver.resolve.mockResolvedValue(mappings);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [] }); // no API key row

    await expect(processJob(job)).resolves.toBeUndefined();
    // S-11: parking states moved from releaseLock(..., 'pending_hardware') to parkPendingHardware
    // which writes per-mapping source rows in 'pending_hardware' status.
    expect(standardAdapter.parkPendingHardware).toHaveBeenCalledWith('m-001', 'tenant-001', mappings);
  });

  test('resolveIdentity returning null parks as pending_identity and returns', async () => {
    const job = makeJob();
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue(null);

    await expect(processJob(job)).resolves.toBeUndefined();
    expect(grantRevoke.processGrant).not.toHaveBeenCalled();
  });

  test('revoke job with no identity logs skip and returns without throwing', async () => {
    const job = makeJob({ name: 'revoke' }, { eventType: 'plan.cancelled' });
    standardAdapter.resolveAndLock.mockResolvedValue(null);

    await expect(processJob(job)).resolves.toBeUndefined();
    const skipLog = stdoutLines.find(l => l.event === 'queue.revoke.no_identity');
    expect(skipLog).toBeDefined();
  });

  test('unknown job name logs queue.job.unknown_name and returns', async () => {
    const job = makeJob({ name: 'unknown-type' });

    await expect(processJob(job)).resolves.toBeUndefined();
    const unknownLog = stdoutLines.find(l => l.event === 'queue.job.unknown_name');
    expect(unknownLog).toBeDefined();
  });

});

// ── Trace context in failure paths ────────────────────────────────────────────

describe('[P1] queue-worker: trace context is bound even in failure paths', () => {

  test('queue.job.failed log line carries the job traceId', async () => {
    const job = makeJob();
    const expectedTraceId = job.data.standardEvent.traceId;
    mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'key' }]);
    standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-001', hardwarePlatform: 'kisi' });
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
    standardAdapter.resolveIdentity.mockResolvedValue('hw-001');
    grantRevoke.processGrant.mockRejectedValue(new Error('hardware down'));

    await expect(processJob(job)).rejects.toThrow();
    const failLog = stdoutLines.find(l => l.event === 'queue.job.failed');
    expect(failLog.traceId).toBe(expectedTraceId);
  });

  test('PLAN_NOT_MAPPED warning log carries the job traceId', async () => {
    const job = makeJob();
    const expectedTraceId = job.data.standardEvent.traceId;
    mappingResolver.resolve.mockResolvedValue(null);
    retryEngine.handleFailure.mockResolvedValue();

    await processJob(job);
    const warnLog = stdoutLines.find(l => l.event === 'queue.grant.plan_unknown');
    expect(warnLog).toBeDefined();
    expect(warnLog.traceId).toBe(expectedTraceId);
  });

});
