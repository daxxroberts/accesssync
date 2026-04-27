/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: queue worker binds trace context from job payload            │
 * │                                                                         │
 * │  Business consequence: ALS does not cross process boundaries. Without  │
 * │  explicit runWith in the worker, every log inside the provisioning     │
 * │  path has no traceId — the member grant lifecycle is unqueryable.      │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// Mock all external dependencies so processJob can be tested in isolation
jest.mock('../../db',                          () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter',   () => ({
  resolveAndLock:  jest.fn(),
  resolveIdentity: jest.fn(),
  completeGrant:   jest.fn(),
  completeRevoke:  jest.fn(),
  releaseLock:     jest.fn(),
  parkPendingStart: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter',   () => ({
  assignRole:     jest.fn(),
  enableAccess:   jest.fn(),
}));
jest.mock('../../core/grant-revoke',           () => ({
  processGrant: jest.fn(),
  processRevoke: jest.fn(),
}));
jest.mock('../../core/plan-mapping-resolver',  () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',           () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/redis-utils',            () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',      () => ({ eventQueue: { getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',           () => ({ decryptApiKey: jest.fn(k => k) }));

// Suppress BullMQ Worker constructor
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  })),
  UnrecoverableError: class UnrecoverableError extends Error { constructor(msg) { super(msg); this.name = 'UnrecoverableError'; } },
  Queue: jest.fn(),
}));

const db = require('../../db');
const standardAdapter  = require('../../adapters/standard-adapter');
const grantRevoke      = require('../../core/grant-revoke');
const mappingResolver  = require('../../core/plan-mapping-resolver');
const { processJob }   = require('../../core/queue-worker');
const { getTraceId, getActor, runWith, mintTraceId } = require('../../core/trace-context');

// Capture stdout
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

afterAll(() => {
  process.stdout.write = originalWrite;
});

beforeEach(() => {
  stdoutLines = [];
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

function makeJob(overrides = {}) {
  const traceId = mintTraceId();
  return {
    id: 'job-test-001',
    name: 'grant',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      tenantId: 'tenant-001',
      standardEvent: {
        traceId,
        eventId: 'evt-001',
        eventType: 'plan.purchased',
        platformMemberId: 'wix-member-abc',
        planId: 'plan-xyz',
        email: null,
        name: null,
      },
    },
    ...overrides,
  };
}

// ── Core trace propagation ────────────────────────────────────────────────────

describe('[P1] queue-worker: trace context from job payload (DR-037)', () => {

  test('worker reads traceId from job payload and binds to ALS', async () => {
    const job = makeJob();
    const expectedTraceId = job.data.standardEvent.traceId;

    let capturedTraceId;
    mappingResolver.resolve.mockResolvedValue([]);

    standardAdapter.resolveAndLock.mockImplementation(async () => {
      capturedTraceId = getTraceId();
      return null;
    });

    await processJob(job).catch(() => {});

    expect(capturedTraceId).toBe(expectedTraceId);
  });

  test('actor is system:queue-worker during job execution', async () => {
    const job = makeJob();

    let capturedActor;
    mappingResolver.resolve.mockResolvedValue([]);

    standardAdapter.resolveAndLock.mockImplementation(async () => {
      capturedActor = getActor();
      return null;
    });

    await processJob(job).catch(() => {});

    expect(capturedActor).toEqual({ type: 'system', id: 'queue-worker' });
  });

  test('downstream log calls in job body carry the job traceId', async () => {
    const job = makeJob();
    const expectedTraceId = job.data.standardEvent.traceId;

    // Return null for the planId → plan not mapped → logs warning + calls retryEngine
    mappingResolver.resolve.mockResolvedValue(null);
    const retryEngine = require('../../core/retry-engine');
    retryEngine.handleFailure.mockResolvedValue();

    await processJob(job);

    const logsWithTrace = stdoutLines.filter(l => l.traceId === expectedTraceId);
    expect(logsWithTrace.length).toBeGreaterThan(0);
  });

  test('worker throws QUEUE_JOB_MISSING_TRACE_ID when traceId missing from payload', async () => {
    const job = makeJob();
    delete job.data.standardEvent.traceId;

    await expect(processJob(job)).rejects.toThrow('QUEUE_JOB_MISSING_TRACE_ID');
  });

  test('worker throws when standardEvent is entirely absent', async () => {
    const job = { id: 'j1', name: 'grant', attemptsMade: 0, opts: { attempts: 3 }, data: { tenantId: 't1' } };
    await expect(processJob(job)).rejects.toThrow('QUEUE_JOB_MISSING_TRACE_ID');
  });

  test('webhook → queue traceId continuity: job payload traceId appears in log lines', async () => {
    const webhookTraceId = mintTraceId();
    const job = makeJob();
    job.data.standardEvent.traceId = webhookTraceId;

    // Return null → plan not mapped path (early exit, logs warnings)
    mappingResolver.resolve.mockResolvedValue(null);
    const retryEngine = require('../../core/retry-engine');
    retryEngine.handleFailure.mockResolvedValue();

    await processJob(job);

    const startLog = stdoutLines.find(l => l.event === 'queue.job.start');
    expect(startLog).toBeDefined();
    expect(startLog.traceId).toBe(webhookTraceId);
  });

});
