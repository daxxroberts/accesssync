/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: one job per (client × person) at a time                      │
 * │                                                                         │
 * │  Business consequence: Wix fires 3-4 webhooks per purchase and each    │
 * │  became a grant job running side by side — on 2026-10-14 four jobs     │
 * │  took the "lock" within 0.8 s and Kisi was called seven times for one  │
 * │  purchase. Beyond burning the 5 req/s Kisi budget, a grant and a       │
 * │  revoke for the same person could interleave. The per-member Redis     │
 * │  lock makes siblings wait; the later ones then hit the OB-47 source    │
 * │  guard and make no door-system call.                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                          () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter',   () => ({
  resolveAndLock: jest.fn(), resolveIdentity: jest.fn(), completeGrant: jest.fn(),
  completeRevoke: jest.fn(), releaseLock: jest.fn(), parkPendingStart: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter',   () => ({ assignRole: jest.fn(), enableAccess: jest.fn() }));
jest.mock('../../core/grant-revoke',           () => ({ processGrant: jest.fn(), processRevoke: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver',  () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',           () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/redis-utils',            () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',      () => ({ eventQueue: { getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',           () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/logger',                 () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log: l, withTrace: () => l };
});
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {},
  DelayedError: class DelayedError extends Error {},
  Queue: jest.fn(),
}));

const { DelayedError } = require('bullmq');
const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');
const mappingResolver = require('../../core/plan-mapping-resolver');
const { processJob, memberLockKey, _setMemberLockClient } = require('../../core/queue-worker');
const { mintTraceId } = require('../../core/trace-context');

/** Just enough of ioredis for the lock: SET NX PX, GET, and the compare-and-delete EVAL. */
class FakeRedis {
  constructor() { this.store = new Map(); }
  async set(key, val, _px, _ttl, nx) {
    if (nx === 'NX' && this.store.has(key)) return null;
    this.store.set(key, val);
    return 'OK';
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async eval(_lua, _n, key, owner) {
    if (this.store.get(key) === owner) { this.store.delete(key); return 1; }
    return 0;
  }
}

const TENANT = 'tenant-001';
const makeJob = (id, platformMemberId = 'wix-member-abc') => ({
  id, name: 'grant', attemptsMade: 0, opts: { attempts: 3 },
  moveToDelayed: jest.fn().mockResolvedValue(undefined),
  data: {
    tenantId: TENANT,
    standardEvent: { traceId: mintTraceId(), eventId: `evt-${id}`, eventType: 'plan.purchased', platformMemberId, planId: 'plan-xyz' },
  },
});

/** A resolveAndLock that holds the job open until `release()` is called, then returns null (job ends). */
const holdOpen = () => {
  let release;
  const gate = new Promise(r => { release = r; });
  return { release, impl: () => gate.then(() => null) };
};
const tick = () => new Promise(r => setImmediate(r));

let redis;
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  mappingResolver.resolve.mockResolvedValue([]);
  standardAdapter.resolveAndLock.mockResolvedValue(null);
  redis = new FakeRedis();
  _setMemberLockClient(redis);
});
afterAll(() => _setMemberLockClient(null));

describe('[P1] queue-worker: per-member serialization', () => {

  test('a sibling job for the same person is parked (moveToDelayed + DelayedError) while the first runs, then runs after it', async () => {
    const a = makeJob('job-A'), b = makeJob('job-B');
    const gate = holdOpen();
    standardAdapter.resolveAndLock.mockImplementationOnce(gate.impl);

    const runA = processJob(a, 'token-A').catch(() => {});
    await tick();
    expect(await redis.get(memberLockKey(TENANT, 'wix-member-abc'))).toBe('job-A');

    await expect(processJob(b, 'token-B')).rejects.toBeInstanceOf(DelayedError);
    expect(b.moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = b.moveToDelayed.mock.calls[0];
    expect(ts).toBeGreaterThan(Date.now());
    expect(ts - Date.now()).toBeLessThan(2000);
    expect(token).toBe('token-B');
    // B did no work: the only resolveAndLock call so far is A's.
    expect(standardAdapter.resolveAndLock).toHaveBeenCalledTimes(1);

    gate.release();
    await runA;
    expect(await redis.get(memberLockKey(TENANT, 'wix-member-abc'))).toBeNull();   // A released on completion

    await processJob(b, 'token-B').catch(() => {});                                   // BullMQ re-runs B later
    expect(b.moveToDelayed).toHaveBeenCalledTimes(1);                                 // not parked again
    expect(standardAdapter.resolveAndLock).toHaveBeenCalledTimes(2);
  });

  test('jobs for different people run side by side', async () => {
    const a = makeJob('job-A', 'person-1'), c = makeJob('job-C', 'person-2');
    const gate = holdOpen();
    standardAdapter.resolveAndLock.mockImplementationOnce(gate.impl);

    const runA = processJob(a, 't').catch(() => {});
    await tick();
    await processJob(c, 't').catch(() => {});
    expect(c.moveToDelayed).not.toHaveBeenCalled();
    expect(standardAdapter.resolveAndLock).toHaveBeenCalledTimes(2);

    gate.release(); await runA;
  });

  test('the lock is released when the job fails, so the next sibling is not stuck behind it', async () => {
    const a = makeJob('job-A'), b = makeJob('job-B');
    standardAdapter.resolveAndLock.mockRejectedValueOnce(new Error('boom'));
    await expect(processJob(a, 't')).rejects.toThrow('boom');
    expect(await redis.get(memberLockKey(TENANT, 'wix-member-abc'))).toBeNull();

    await processJob(b, 't').catch(() => {});
    expect(b.moveToDelayed).not.toHaveBeenCalled();
  });

  test('a job never releases a lock it does not own (TTL already handed it to a sibling)', async () => {
    await redis.set(memberLockKey(TENANT, 'wix-member-abc'), 'zombie-job');
    const b = makeJob('job-B');
    await expect(processJob(b, 't')).rejects.toBeInstanceOf(DelayedError);
    expect(await redis.get(memberLockKey(TENANT, 'wix-member-abc'))).toBe('zombie-job');
  });

  test('without a Redis client (no Worker built) jobs run unlocked, exactly as before', async () => {
    _setMemberLockClient(null);
    const a = makeJob('job-A'), b = makeJob('job-B');
    const gate = holdOpen();
    standardAdapter.resolveAndLock.mockImplementationOnce(gate.impl);

    const runA = processJob(a, 't').catch(() => {});
    await tick();
    await processJob(b, 't').catch(() => {});
    expect(b.moveToDelayed).not.toHaveBeenCalled();
    expect(standardAdapter.resolveAndLock).toHaveBeenCalledTimes(2);
    gate.release(); await runA;
  });

  test('the lock key is scoped to the client, so two gyms with the same platform id never block each other', () => {
    expect(memberLockKey('gym-1', 'm')).not.toBe(memberLockKey('gym-2', 'm'));
    expect(memberLockKey('gym-1', 'holder###as959cf8')).toBe('accesssync:member-lock:gym-1:holder###as959cf8');
  });
});
