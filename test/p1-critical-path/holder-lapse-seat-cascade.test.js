/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a holder's plan ending in Wix takes its seats with it        │
 * │                                                                         │
 * │  Business consequence: the webhook revoke only ever touched the         │
 * │  HOLDER. The seats on that plan (sub-members) were left to the          │
 * │  reconcile's Pass 1.5, which runs observation-only. 2026-10-15 review:  │
 * │  a Family order ended Oct 4 and its four seats still opened the door    │
 * │  eleven days later. On a paying gym that is free access, indefinitely.  │
 * │                                                                         │
 * │  Each active seat now gets the same synthetic per-plan revoke the       │
 * │  Member Hub's "remove sub-member" has used in production (DR-044).      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                          () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter',   () => ({
  resolveAndLock: jest.fn(), resolveIdentity: jest.fn(), completeGrant: jest.fn(),
  completeRevoke: jest.fn(), releaseLock: jest.fn(), parkPendingStart: jest.fn(),
  markSubMemberRemoving: jest.fn(), finalizeRevoke: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter',   () => ({ assignRole: jest.fn(), enableAccess: jest.fn() }));
jest.mock('../../core/grant-revoke',           () => ({ processGrant: jest.fn(), processRevoke: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver',  () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',           () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/redis-utils',            () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',      () => ({ eventQueue: { getJob: jest.fn(), add: jest.fn() } }));
jest.mock('../../core/crypto-utils',           () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/member-mailer',          () => ({
  captureAccessRemovedContext: jest.fn().mockResolvedValue(null),
  maybeSendAccessRemovedEmail: jest.fn(), maybeSendAccessSuspendedEmail: jest.fn(),
  maybeSendGrantEmail: jest.fn(), maybeSendAccessRestoredEmail: jest.fn(), maybeSendDayPassEmail: jest.fn(),
}));
jest.mock('../../core/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log: l, withTrace: () => l };
});
// registerTrace's fire-and-forget setImmediate would lazily require db after the Jest environment
// is torn down (harmless in production, noisy here); the rest of trace-context stays real.
jest.mock('../../core/trace-context', () => ({ ...jest.requireActual('../../core/trace-context'), registerTrace: jest.fn() }));
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {},
  DelayedError: class DelayedError extends Error {},
  Queue: jest.fn(),
}));

const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');
const grantRevoke     = require('../../core/grant-revoke');
const { eventQueue }  = require('../../core/webhook-processor');
const { log }         = require('../../core/logger');
const { processJob, HOLDER_LAPSE_CASCADE_SOURCE } = require('../../core/queue-worker');
const { mintTraceId } = require('../../core/trace-context');

const TENANT   = '15962eac-c767-46ad-8056-094f35a4a193';
const HOLDER   = '2a6e78ae-c687-4001-b241-513a39ef8964';
const PLAN     = '0d478601-8e54-4628-ba17-c5e14995b490';   // Family
const SEAT_SQL = /sub\.sub_master_id = holder_mm\.id/;

const seat = (n, over = {}) => ({
  sub_access_id: `seat-access-${n}`, platform_member_id: `${HOLDER}###as${n}`,
  sub_status: 'active', hardware_user_id: `10536870${n}`, source_status: 'active', ...over,
});

const holderJob = (over = {}) => ({
  id: 'job-holder-ended', name: 'revoke', attemptsMade: 0, opts: { attempts: 3 },
  data: {
    tenantId: TENANT,
    standardEvent: {
      traceId: mintTraceId(), eventId: 'evt-order-ended-1', eventType: 'plan.cancelled',
      platformMemberId: HOLDER, planId: PLAN, sourcePlatform: 'wix', wixOrderId: '972896c2', ...over,
    },
  },
});

/** db.query: the seat lookup returns `seats`; everything else returns no rows. */
const seatsAre = (seats) => db.query.mockImplementation(async (sql) => ({ rows: SEAT_SQL.test(sql) ? seats : [] }));

const queuedEvents = () => eventQueue.add.mock.calls.map(c => ({ name: c[0], ...c[1].standardEvent, jobId: c[2].jobId }));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HOLDER_LAPSE_CASCADE;
  seatsAre([]);
  standardAdapter.markSubMemberRemoving.mockResolvedValue(undefined);
  eventQueue.add.mockResolvedValue({ id: 'queued' });
  // The holder's own revoke: identity found, hardware revoke → 'inactive', finalize ok.
  standardAdapter.resolveAndLock.mockResolvedValue({ memberId: 'holder-access', hardwareUserId: '99561846', hardwarePlatform: 'kisi', roleAssignmentIds: ['98601860'] });
  grantRevoke.processRevoke.mockResolvedValue('inactive');
  standardAdapter.finalizeRevoke.mockResolvedValue({ finalized: true, reason: null });
});

describe('[P1] holder-lapse seat cascade', () => {

  test('Wix ends a Family order with four active seats → four seat revokes queued, each marked removing first', async () => {
    seatsAre([seat(1), seat(2), seat(3), seat(4)]);
    await processJob(holderJob());

    const queued = queuedEvents();
    expect(queued).toHaveLength(4);
    for (const q of queued) {
      expect(q.name).toBe('revoke');
      expect(q.eventType).toBe('plan.cancelled');
      expect(q.planId).toBe(PLAN);                                   // targets THAT plan's source row (OB-150)
      expect(q.synthetic).toBe(true);
      expect(q.syntheticSource).toBe(HOLDER_LAPSE_CASCADE_SOURCE);
      expect(q.holderPlatformMemberId).toBe(HOLDER);
      expect(q.traceId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(queued.map(q => q.platformMemberId).sort()).toEqual([1, 2, 3, 4].map(n => `${HOLDER}###as${n}`));
    expect(standardAdapter.markSubMemberRemoving).toHaveBeenCalledTimes(4);
    expect(standardAdapter.markSubMemberRemoving.mock.calls.map(c => c[0]).sort()).toEqual(['seat-access-1', 'seat-access-2', 'seat-access-3', 'seat-access-4']);
    // The holder's own revoke still ran.
    expect(grantRevoke.processRevoke).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('queue.revoke.holder_lapse.cascade_queued', expect.objectContaining({ subAccessId: 'seat-access-1', planId: PLAN }));
  });

  test('job ids are deterministic per (seat, plan, holder webhook) — a retried holder job cannot queue a seat twice', async () => {
    seatsAre([seat(1)]);
    await processJob(holderJob());
    const first = queuedEvents()[0].jobId;
    expect(first).toBe(`revoke-holder-lapse-seat-access-1-${PLAN}-evt-order-ended-1`);

    jest.clearAllMocks(); seatsAre([seat(1)]); eventQueue.add.mockResolvedValue({ id: 'queued' });
    standardAdapter.resolveAndLock.mockResolvedValue(null);
    await processJob(holderJob({ traceId: mintTraceId() }));
    expect(queuedEvents()[0].jobId).toBe(first);                     // BullMQ dedupes on jobId
  });

  test('a holder who already released their own seat (no active access row) still takes the seats down', async () => {
    seatsAre([seat(1), seat(2)]);
    standardAdapter.resolveAndLock.mockResolvedValue(null);          // DR-051 self-release → no_identity
    await processJob(holderJob());
    expect(queuedEvents()).toHaveLength(2);
    expect(grantRevoke.processRevoke).not.toHaveBeenCalled();
  });

  test('a seat that is pending (no hardware yet) or whose source is not active is skipped and logged, not queued', async () => {
    seatsAre([
      seat(1),
      seat(2, { hardware_user_id: null, source_status: 'pending_hardware' }),
      seat(3, { source_status: 'pending_start' }),
      seat(4, { sub_status: 'inactive' }),
    ]);
    await processJob(holderJob());
    expect(queuedEvents().map(q => q.platformMemberId)).toEqual([`${HOLDER}###as1`]);
    expect(standardAdapter.markSubMemberRemoving).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls.filter(c => c[0] === 'queue.revoke.holder_lapse.seat_skipped')).toHaveLength(3);
  });

  test('one seat failing to queue does not stop the others', async () => {
    seatsAre([seat(1), seat(2), seat(3)]);
    eventQueue.add
      .mockResolvedValueOnce({ id: 'q1' })
      .mockRejectedValueOnce(new Error('redis hiccup'))
      .mockResolvedValueOnce({ id: 'q3' });
    await processJob(holderJob());
    expect(eventQueue.add).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith('queue.revoke.holder_lapse.cascade_failed', expect.objectContaining({ subAccessId: 'seat-access-2' }), expect.any(Error));
    expect(grantRevoke.processRevoke).toHaveBeenCalledTimes(1);     // holder's own revoke unaffected
  });

  test.each([
    ['a seat\'s own synthetic revoke (no recursion)', { synthetic: true, syntheticSource: HOLDER_LAPSE_CASCADE_SOURCE, platformMemberId: `${HOLDER}###as1` }],
    ['a Member Hub remove_sub synthetic',           { synthetic: true, syntheticSource: 'multi-member.remove_sub' }],
    ['payment.failed (suspend, not a lapse)',       { eventType: 'payment.failed' }],
    ['booking.cancelled',                           { eventType: 'booking.cancelled' }],
    ['plan.cancelled with no planId',               { planId: null }],
  ])('%s never cascades', async (_label, over) => {
    seatsAre([seat(1)]);
    grantRevoke.processRevoke.mockResolvedValue(over.eventType === 'payment.failed' ? 'disabled' : 'inactive');
    await processJob(holderJob(over)).catch(() => {});
    expect(db.query.mock.calls.some(c => SEAT_SQL.test(c[0]))).toBe(false);
    expect(eventQueue.add).not.toHaveBeenCalled();
  });

  test('HOLDER_LAPSE_CASCADE=off is a kill switch: nothing queued, one persisted log line says so', async () => {
    process.env.HOLDER_LAPSE_CASCADE = 'off';
    seatsAre([seat(1)]);
    await processJob(holderJob());
    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(c => SEAT_SQL.test(c[0]))).toBe(false);
    expect(log.info).toHaveBeenCalledWith('queue.revoke.holder_lapse.cascade_disabled', expect.objectContaining({ holderPlatformMemberId: HOLDER }));
  });

  test('the seat lookup is scoped to the client and the ended plan', async () => {
    seatsAre([]);
    await processJob(holderJob());
    const [sql, params] = db.query.mock.calls.find(c => SEAT_SQL.test(c[0]));
    expect(sql).toMatch(/holder_mm\.client_id\s*=\s*\$1/);
    expect(sql).toMatch(/mas\.source_plan_id = \$3/);
    expect(params).toEqual([TENANT, 'wix', PLAN, HOLDER]);
  });
});
