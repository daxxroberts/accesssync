/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: reconciliation never enqueues a job without a traceId        │
 * │                                                                         │
 * │  Business consequence: queue-worker.js:77 throws QUEUE_JOB_MISSING_     │
 * │  TRACE_ID before runWith() executes, so BullMQ marks the job exhausted  │
 * │  on attempt 1. A traceId-less recon revoke = a member who should have   │
 * │  lost access keeps it. Surfaced in Railway 2026-04-29.                  │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(),
  getManagedRoleAssignments: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders: jest.fn(),
  listConfirmedBookings: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k) }));

const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const recon = require('../../core/reconciliation');

// Phase 1 (2026-09-10): the sweep's error_queue replay is GRANT-only and only
// for members PAYING in this sweep's Wix read — the caller passes that snapshot
// (clientId → memberId → PAYING planIds). The traceId guard sits on the enqueue
// path, which only grants reach, so these cases replay grants.
const payingSnapshot = (clientId, memberId) => new Map([[clientId, new Map([[memberId, new Set()]])]]);

beforeEach(() => {
  db.query.mockReset();
  eventQueue.add.mockClear();
  recon._sweepTraceId = null;
});

// Phase 1 tripwire: no reconciliation path may enqueue a revoke.
afterEach(() => {
  expect(eventQueue.add.mock.calls.filter(c => c[0] === 'revoke')).toEqual([]);
});

describe('[P3] reconciliation: re-queue guards against missing traceId', () => {

  test('mints a traceId when error_queue payload lacks one', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'eq-1',
        event_type: 'plan.purchased',
        payload: JSON.stringify({
          eventType: 'plan.purchased',
          sourcePlatform: 'wix',
          platformMemberId: 'member-1',
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm1',
      client_id: 'c1',
      platform_member_id: 'member-1',
    }, payingSnapshot('c1', 'member-1'));

    expect(eventQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload] = eventQueue.add.mock.calls[0];
    expect(jobName).toBe('grant');
    expect(payload.standardEvent.traceId).toEqual(expect.any(String));
    expect(payload.standardEvent.traceId.length).toBeGreaterThan(0);
  });

  test('preserves existing traceId from error_queue payload', async () => {
    const originalTrace = '11111111-2222-3333-4444-555555555555';
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'eq-2',
        event_type: 'plan.purchased',
        payload: JSON.stringify({
          eventType: 'plan.purchased',
          sourcePlatform: 'wix',
          platformMemberId: 'member-2',
          traceId: originalTrace,
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm2',
      client_id: 'c2',
      platform_member_id: 'member-2',
    }, payingSnapshot('c2', 'member-2'));

    expect(eventQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = eventQueue.add.mock.calls[0];
    expect(payload.standardEvent.traceId).toBe(originalTrace);
  });

  test('uses sweep traceId when available, mints new when both missing', async () => {
    recon._sweepTraceId = 'sweep-trace-abc';
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'eq-3',
        event_type: 'booking.confirmed',
        payload: JSON.stringify({
          eventType: 'booking.confirmed',
          sourcePlatform: 'wix',
          platformMemberId: 'member-3',
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm3',
      client_id: 'c3',
      platform_member_id: 'member-3',
    }, payingSnapshot('c3', 'member-3'));

    expect(eventQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = eventQueue.add.mock.calls[0];
    expect(payload.standardEvent.traceId).toBe('sweep-trace-abc');
  });
});
