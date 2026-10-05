/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a member's grant is refused by the door system (4xx)         │
 * │                                                                         │
 * │  Business consequence: a 4xx (bad key, missing group, rejected person)  │
 * │  ends the BullMQ job on its FIRST attempt. The dead-letter step used to │
 * │  require all 3 attempts, so every such failure vanished: no error row,  │
 * │  no operator email, and both panels read "Clean" while a paying member  │
 * │  had no door access. These tests pin that every refused grant reaches   │
 * │  the operator, and that transient errors still retry before alerting.   │
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

const handlers = {};
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn((evt, fn) => { handlers[evt] = fn; }) })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
  Queue: jest.fn(),
}));

const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');
const grantRevoke     = require('../../core/grant-revoke');
const mappingResolver = require('../../core/plan-mapping-resolver');
const retryEngine     = require('../../core/retry-engine');
const { processJob, startWorker } = require('../../core/queue-worker');
const { mintTraceId } = require('../../core/trace-context');

const makeJob = (over = {}) => ({
  id: 'job-4xx', name: 'grant', attemptsMade: 1, opts: { attempts: 3 },
  data: {
    tenantId: 'tenant-001',
    standardEvent: { traceId: mintTraceId(), eventId: 'evt-1', eventType: 'plan.purchased', platformMemberId: 'wix-m-1', planId: 'plan-1' },
  },
  ...over,
});

/** The error shape adapters/kisi/kisi-connector.js throws for a 422. */
function kisi422() {
  const e = new Error('Kisi 422: unknown');
  Object.assign(e, {
    statusCode: 422, code: 'HARDWARE_VALIDATION_ERROR',
    userMessage: 'Your door system rejected the request.', action: 'Try retrying.', resolution: 'RETRY', body: { error: 'x' },
  });
  return e;
}

async function runGrantThatFailsWith(err) {
  mappingResolver.resolve.mockResolvedValue([{ hardwarePlatform: 'kisi', hardwareGroupId: 'g-1', mappingId: 'm-1', apiKey: 'k' }]);
  standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'm-001', hardwareUserId: 'hw-1', hardwarePlatform: 'kisi' });
  standardAdapter.resolveIdentity.mockResolvedValue('hw-1');
  grantRevoke.processGrant.mockRejectedValue(err);
  let thrown;
  try { await processJob(makeJob()); } catch (e) { thrown = e; }
  return thrown;
}

beforeAll(() => { startWorker(); });
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc' }] });
});

describe('[P1] a refused (4xx) grant reaches the operator on its first attempt', () => {
  test('the unrecoverable error keeps the original code, status, message, action and body', async () => {
    const thrown = await runGrantThatFailsWith(kisi422());
    expect(thrown.name).toBe('UnrecoverableError');
    expect(thrown).toMatchObject({
      code: 'HARDWARE_VALIDATION_ERROR', statusCode: 422, resolution: 'RETRY',
      userMessage: 'Your door system rejected the request.', body: { error: 'x' },
    });
    expect(thrown.original.message).toBe('Kisi 422: unknown');
  });

  test('worker "failed" at attempt 1 of 3 with an UnrecoverableError → dead-lettered (error_queue + email)', async () => {
    const thrown = await runGrantThatFailsWith(kisi422());
    await handlers.failed(makeJob({ attemptsMade: 1 }), thrown);
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
    const [, err] = retryEngine.handleFailure.mock.calls[0];
    expect(err.code).toBe('HARDWARE_VALIDATION_ERROR');     // so error_queue can dedupe on it
    expect(err.statusCode).toBe(422);
  });

  test.each([401, 403, 404, 422])('every refused status (%s) is dead-lettered', async (status) => {
    const e = new Error(`Kisi ${status}`); e.statusCode = status;
    const thrown = await runGrantThatFailsWith(e);
    await handlers.failed(makeJob({ attemptsMade: 1 }), thrown);
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
  });
});

describe('[P1] transient errors still retry before alerting (unchanged)', () => {
  test('a 500 at attempt 1 of 3 is NOT dead-lettered yet', async () => {
    const e = new Error('Kisi 500'); e.statusCode = 500;
    await handlers.failed(makeJob({ attemptsMade: 1 }), e);
    expect(retryEngine.handleFailure).not.toHaveBeenCalled();
  });

  test('a 500 that has used all 3 attempts IS dead-lettered', async () => {
    const e = new Error('Kisi 500'); e.statusCode = 500;
    await handlers.failed(makeJob({ attemptsMade: 3 }), e);
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);
  });

  test('a 429 is still retryable (not wrapped as unrecoverable)', async () => {
    const e = new Error('rate limited'); e.statusCode = 429;
    const thrown = await runGrantThatFailsWith(e);
    expect(thrown.name).not.toBe('UnrecoverableError');
  });

  test('an in-flight lock collision is still thrown as-is for retry', async () => {
    const e = new Error('locked'); e.code = 'IN_FLIGHT_LOCK';
    const thrown = await runGrantThatFailsWith(e);
    expect(thrown.code).toBe('IN_FLIGHT_LOCK');
    expect(thrown.name).not.toBe('UnrecoverableError');
  });
});
